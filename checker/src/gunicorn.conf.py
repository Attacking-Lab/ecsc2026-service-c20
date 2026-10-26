import multiprocessing
import os

worker_class = "uvicorn.workers.UvicornWorker"
workers = int(
    os.environ.get("CHECKER_WEB_CONCURRENCY", min(4, multiprocessing.cpu_count() - 1))
)
bind = "0.0.0.0:8000"
timeout = 90
keepalive = 3600
preload_app = True
