FROM python:3.11-slim
# 公开 Terminal-Bench 任务的 pytest 评分器只依赖 Python 标准库；镜像固定 pytest 版本，
# 保证「同一评分器」这一对照前提可复现。/app 为上游评分器硬编码的工作目录。
RUN pip install --no-cache-dir pytest==8.3.3
WORKDIR /app
