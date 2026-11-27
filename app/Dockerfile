FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
RUN pip install --no-cache-dir openpyxl==3.1.5

COPY . /app

EXPOSE 8080
CMD ["python", "servidor.py"]
