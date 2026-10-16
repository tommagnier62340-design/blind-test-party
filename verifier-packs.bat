@echo off
cd /d "%~dp0"
echo (le jeu doit tourner : start.bat)
node verifier-packs.js %1
echo.
echo Resultat enregistre dans verification.txt
pause
