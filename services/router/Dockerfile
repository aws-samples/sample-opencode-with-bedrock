FROM public.ecr.aws/amazonlinux/amazonlinux:2023

WORKDIR /app

# Install system dependencies: Python 3.12 (latest packaged in AL2023), pip,
# runtime libs for Pillow (libjpeg-turbo, zlib), and curl for health checks.
# dnf update applies the latest security patches (equivalent to apt-get upgrade).
RUN dnf -y update \
    && dnf -y install \
        python3.12 \
        python3.12-pip \
        libjpeg-turbo \
        zlib \
        curl-minimal \
        shadow-utils \
    && dnf clean all \
    && rm -rf /var/cache/dnf \
    # Provide a `python` alias. AL2023 only installs the interpreter as
    # `python3.12`; the ECS task definition health check (defined in the CDK
    # api-stack) invokes `python`, so this symlink keeps that contract working.
    && ln -sf /usr/bin/python3.12 /usr/local/bin/python \
    && ln -sf /usr/bin/python3.12 /usr/local/bin/python3

# Install Python dependencies
COPY requirements.txt .
RUN python3.12 -m pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py .

# Create non-root user for security
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

# Environment defaults
ENV PORT=8080
ENV LOG_LEVEL=INFO
ENV PYTHONUNBUFFERED=1

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')" || exit 1

EXPOSE 8080

CMD ["python", "main.py"]
