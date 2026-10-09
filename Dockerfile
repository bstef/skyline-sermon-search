FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY sermon_search ./sermon_search
ENV SERMON_DB=/data/sermons.sqlite3
RUN mkdir /data && useradd --uid 10001 --create-home appuser && chown appuser /data
USER appuser
EXPOSE 8000
CMD ["uvicorn", "sermon_search.app:app", "--host", "0.0.0.0", "--port", "8000"]
