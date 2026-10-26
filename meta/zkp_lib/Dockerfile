FROM python:3.11-slim

RUN apt-get update
RUN apt-get install -y gcc python3-dev make libzstd-dev

WORKDIR /build

COPY . /build

RUN make
