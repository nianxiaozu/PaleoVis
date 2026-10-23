@echo off
chcp 65001 >nul
setlocal

REM ====== 激活 conda 环境 ======
REM 如果下面这行报"conda 不是内部命令"，改用你本机的 activate.bat 路径，例如：
REM call "D:/Anaconda3/Scripts\activate.bat" eastclimate_env
call conda activate easyclimate_env
if errorlevel 1 (
    echo [错误] 激活 conda 环境 eastclimate_env 失败
    pause
    exit /b 1
)

REM ====== 以 UTF-8 编码执行 PowerShell 脚本 ======
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; & '.\run.ps1'"

if errorlevel 1 (
    echo [错误] run.ps1 执行失败，退出码 %errorlevel%
)

pause
