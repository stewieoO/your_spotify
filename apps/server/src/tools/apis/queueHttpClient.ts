export type RequestPriority = "normal" | "high";

interface HttpClientRequestConfig {
  method: string;
  url: string;
  data?: any;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  priority?: RequestPriority;
  retry429MaxAttempts?: number;
  bypassRateLimit?: boolean;
}

interface HttpClientResponse<T> {
  status: number;
  statusText: string;
  data: T;
}

interface QueueItem<T = any> {
  config: HttpClientRequestConfig;
  resolve: (value: HttpClientResponse<T>) => void;
  reject: (reason?: unknown) => void;
  retry429AttemptCount: number;
}

interface QueueState {
  highPriorityQueue: QueueItem<any>[];
  normalPriorityQueue: QueueItem<any>[];
  isProcessingQueue: boolean;
  retryAfterUntil: number;
  processQueueTimer: ReturnType<typeof setTimeout> | null;
}

export class HttpError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly body: string;
  public readonly retryAfterMs?: number;

  constructor(options: {
    status: number;
    statusText: string;
    body: string;
    retryAfterMs?: number;
  }) {
    super(
      `HTTP error! status: ${options.status}, statusText: ${options.statusText}, body: ${options.body}`,
    );
    this.status = options.status;
    this.statusText = options.statusText;
    this.body = options.body;
    this.retryAfterMs = options.retryAfterMs;
  }
}

const DEFAULT_RETRY_429_MAX_ATTEMPTS = 1;
const DEFAULT_RETRY_AFTER_MS = 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function createQueueState(): QueueState {
  return {
    highPriorityQueue: [],
    normalPriorityQueue: [],
    isProcessingQueue: false,
    retryAfterUntil: 0,
    processQueueTimer: null,
  };
}

export class QueuedHttpClientFactory {
  private readonly queueState: QueueState = createQueueState();

  constructor(
    private readonly options: {
      baseURL: string;
      headers: Record<string, string>;
    },
  ) {}

  createClient(headers: Record<string, string>) {
    const mergedHeaders = { ...this.options.headers, ...headers };
    return new QueuedHttpClient(
      this.options.baseURL,
      mergedHeaders,
      this.queueState,
    );
  }
}

export class QueuedHttpClient {
  constructor(
    private readonly baseURL: string,
    private readonly headers: Record<string, string>,
    private readonly queueState: QueueState = createQueueState(),
  ) {}

  request<T = any>(
    config: HttpClientRequestConfig,
  ): Promise<HttpClientResponse<T>> {
    return new Promise<HttpClientResponse<T>>((resolve, reject) => {
      const queueItem: QueueItem<T> = {
        config: {
          ...config,
          headers: { ...this.headers, ...config.headers },
          url: config.url.startsWith("http")
            ? config.url
            : this.baseURL + config.url,
        },
        resolve,
        reject,
        retry429AttemptCount: 0,
      };

      this.enqueue(queueItem);

      this.processQueue();
    });
  }

  get<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "get", url });
  }

  delete<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "delete", url });
  }

  head<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "head", url });
  }

  options<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "options", url });
  }

  post<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "post", url });
  }

  put<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "put", url });
  }

  patch<T = any>(url: string, config?: Partial<HttpClientRequestConfig>) {
    return this.request<T>({ ...config, method: "patch", url });
  }

  private processQueue() {
    if (this.queueState.isProcessingQueue) {
      return;
    }

    const bypassRateLimitIndex = this.queueState.highPriorityQueue.findIndex(
      (item) => item.config.bypassRateLimit,
    );
    let next =
      bypassRateLimitIndex >= 0
        ? this.queueState.highPriorityQueue.splice(bypassRateLimitIndex, 1)[0]
        : undefined;

    if (!next && this.queueState.retryAfterUntil > Date.now()) {
      this.scheduleQueueProcessing();
      return;
    }

    next ??= this.dequeueNext();
    if (!next) {
      return;
    }

    this.queueState.isProcessingQueue = true;

    this.execute(next)
      .catch((error) => {
        next.reject(error);
      })
      .finally(() => {
        this.queueState.isProcessingQueue = false;
        this.processQueue();
      });
  }

  private async execute<T = any>(queueItem: QueueItem<T>) {
    const url = new URL(queueItem.config.url);

    if (queueItem.config.params) {
      Object.entries(queueItem.config.params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    const payload: RequestInit = {
      method: queueItem.config.method,
      headers: queueItem.config.headers,
      body: queueItem.config.data
        ? JSON.stringify(queueItem.config.data)
        : undefined,
      credentials: "include",
    };

    const response = await fetch(url, payload);

    const text = await response.text();
    if (!response.ok) {
      const retryAfterMs =
        response.status === 429 ? this.parseRetryAfterHeader(response) : undefined;

      if (response.status !== 429) {
        throw new HttpError({
          status: response.status,
          statusText: response.statusText,
          body: text,
        });
      }

      this.queueState.retryAfterUntil = Math.max(
        this.queueState.retryAfterUntil,
        Date.now() + (retryAfterMs ?? 0),
      );

      const maxAttempts =
        queueItem.config.retry429MaxAttempts ?? DEFAULT_RETRY_429_MAX_ATTEMPTS;
      if (queueItem.retry429AttemptCount >= maxAttempts) {
        throw new HttpError({
          status: response.status,
          statusText: response.statusText,
          body: text,
          retryAfterMs,
        });
      }

      queueItem.retry429AttemptCount += 1;
      this.requeue(queueItem);
      return;
    }

    const data = text ? JSON.parse(text) : undefined;
    queueItem.resolve({
      data,
      status: response.status,
      statusText: response.statusText,
    });
  }

  private requeue(queueItem: QueueItem<any>) {
    if (queueItem.config.priority === "high") {
      this.queueState.highPriorityQueue.unshift(queueItem);
      return;
    }
    this.queueState.normalPriorityQueue.unshift(queueItem);
  }

  private enqueue(queueItem: QueueItem<any>) {
    if (queueItem.config.priority === "high") {
      this.queueState.highPriorityQueue.push(queueItem);
      return;
    }

    this.queueState.normalPriorityQueue.push(queueItem);
  }

  private dequeueNext() {
    return (
      this.queueState.highPriorityQueue.shift() ??
      this.queueState.normalPriorityQueue.shift()
    );
  }

  private scheduleQueueProcessing() {
    if (this.queueState.processQueueTimer) {
      return;
    }
    const delay = Math.max(0, this.queueState.retryAfterUntil - Date.now());
    this.queueState.processQueueTimer = setTimeout(() => {
      this.queueState.processQueueTimer = null;
      this.processQueue();
    }, Math.min(delay, MAX_TIMEOUT_MS));
  }

  private parseRetryAfterHeader(response: Response) {
    const retryAfter = response.headers.get("retry-after");
    if (!retryAfter) {
      return DEFAULT_RETRY_AFTER_MS;
    }

    const retryAfterValue = Array.isArray(retryAfter)
      ? retryAfter[0]
      : retryAfter;

    const retryAfterAsNumber = Number(retryAfterValue);
    if (!Number.isNaN(retryAfterAsNumber)) {
      return Math.max(0, retryAfterAsNumber * 1000);
    }

    const retryAtTimestamp = Date.parse(retryAfterValue);
    if (Number.isNaN(retryAtTimestamp)) {
      return DEFAULT_RETRY_AFTER_MS;
    }

    return Math.max(0, retryAtTimestamp - Date.now());
  }

}
