FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home app
COPY --chown=app:app . .
RUN mkdir -p /app/instance && chown app:app /app/instance
USER app
EXPOSE 8000
CMD ["python", "serve.py"]
