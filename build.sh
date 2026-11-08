#!/bin/sh

docker build -f Dockerfile.client.production . -t stewieoo/your_spotify_client:latest ; cd -
docker build -f Dockerfile.server.production . -t stewieoo/your_spotify_server:latest ; cd -