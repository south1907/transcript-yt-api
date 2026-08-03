"""WSGI entry for gunicorn (gthread — supports flask-sock).

  gunicorn --worker-class gthread --threads 20 -w 1 -b 0.0.0.0:5000 wsgi:app
"""
from app import app  # noqa: F401
