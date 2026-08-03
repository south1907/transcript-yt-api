FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=5000

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000

# Single process + threads: in-memory worker/job state stays consistent.
CMD ["gunicorn", "--worker-class", "gthread", "--threads", "20", "-w", "1", "--bind", "0.0.0.0:5000", "--timeout", "120", "wsgi:app"]
