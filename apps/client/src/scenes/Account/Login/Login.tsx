import { useEffect, useState } from "react";
import { useSelector } from "react-redux";
import { Checkbox } from "@mui/material";
import clsx from "clsx";
import Text from "../../../components/Text";
import { selectUser } from "../../../services/redux/modules/user/selector";
import { getSpotifyLogUrl } from "../../../services/tools";
import s from "../index.module.css";
import { LocalStorage, REMEMBER_ME_KEY } from "../../../services/storage";
import { useNavigate } from "../../../services/hooks/useNavigate";

export default function Login() {
  const navigate = useNavigate();
  const user = useSelector(selectUser);
  const query = new URLSearchParams(window.location.search);
  const loginError = query.get("error");
  const retryAfter = Number(query.get("retryAfter"));
  const retryAfterMinutes = Math.ceil(retryAfter / 60);
  const [rememberMe, setRememberMe] = useState(
    LocalStorage.get(REMEMBER_ME_KEY) === "true",
  );

  useEffect(() => {
    if (user) {
      navigate("/");
    } else if (
      !loginError &&
      LocalStorage.get(REMEMBER_ME_KEY) === "true"
    ) {
      window.location.href = getSpotifyLogUrl();
    }
  }, [loginError, navigate, user]);

  const handleRememberMeClick = async () => {
    const newRememberMe = !rememberMe;
    setRememberMe(newRememberMe);
    if (newRememberMe) {
      LocalStorage.set(REMEMBER_ME_KEY, "true");
    } else {
      LocalStorage.delete(REMEMBER_ME_KEY);
    }
  };

  return (
    <div className={s.root}>
      <Text size="pagetitle" element="h1" className={s.title}>
        Login
      </Text>
      <Text size="big" className={s.welcome}>
        To access your personal dashboard, please login with your account
      </Text>
      {loginError === "spotify_rate_limited" && (
        <div role="alert">
          <Text size="normal">
            Spotify is temporarily rate limiting login. Please try again
            {retryAfterMinutes > 0
              ? ` in about ${retryAfterMinutes} ${retryAfterMinutes === 1 ? "minute" : "minutes"}`
              : " shortly"}
            .
          </Text>
        </div>
      )}
      {loginError === "spotify_auth_failed" && (
        <div role="alert">
          <Text size="normal">Spotify login failed. Please try again.</Text>
        </div>
      )}
      <div>
        <a className={s.link} href={getSpotifyLogUrl()}>
          Login
        </a>
      </div>
      <div>
        <button
          type="button"
          className={clsx("no-button", s.rememberMe)}
          onClick={handleRememberMeClick}>
          <Checkbox
            checked={rememberMe}
            disableRipple
            disableTouchRipple
            disableFocusRipple
            classes={{ root: s.check }}
          />
          <Text size="normal">Remember me</Text>
        </button>
      </div>
    </div>
  );
}
