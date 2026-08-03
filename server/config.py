import os


class Config:
    HOST = os.getenv("HOST", "0.0.0.0")
    PORT = int(os.getenv("PORT", "5000"))
    SECRET_KEY = os.getenv("SECRET_KEY", "change-me-in-production")
    API_KEY = os.getenv("API_KEY", "")  # optional; empty = no auth
    WORKER_TOKEN = os.getenv("WORKER_TOKEN", "")  # optional; empty = no worker auth
    JOB_TIMEOUT_SEC = int(os.getenv("JOB_TIMEOUT_SEC", "45"))
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")
