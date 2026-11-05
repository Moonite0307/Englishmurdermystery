@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 沉浸式 AI 剧本杀语言学习助手 ...
echo （如需修改 API 密钥，请编辑 config.json，保存后立即生效）
node server.js
pause
