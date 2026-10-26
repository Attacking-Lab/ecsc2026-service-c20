# C20 Demo Client

Build from the repository root:

```sh
docker build -f client/Dockerfile -t c20-client .
```

Run against the compose service from the compose network:

```sh
docker run --rm -it --network c20 c20-client --url http://service:9000
```

Run the full noninteractive functionality check:

```sh
docker run --rm --network c20 c20-client --url http://service:9000 --demo
```

When running the client directly on the host, its default API URL is
`http://localhost:9000/c20`, matching the checker and browser path through the
published frontend proxy. The explicit `http://service:9000` URL above talks to
the backend directly from inside the compose network.
