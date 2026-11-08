#!/bin/sh

cd client && docker build -f Dockerfile.production . -t stewieoo/your_spotify_client:latest ; cd -
cd server && docker build -f Dockerfile.production . -t stewieoo/your_spotify_server:latest ; cd -