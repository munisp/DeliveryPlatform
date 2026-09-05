FROM python:3.12-slim
ARG SERVICE
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/services
WORKDIR /app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd --system --uid 10001 --create-home switchos
COPY . /app/services
RUN test -n "$SERVICE" && test -f "/app/services/${SERVICE}/main.py"
WORKDIR /app/services/${SERVICE}
USER 10001:10001
CMD ["sh", "-c", "exec python -m uvicorn main:app --host ${BIND_HOST:-0.0.0.0} --port ${PORT:-8000}"]
