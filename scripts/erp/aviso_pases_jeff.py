#!/usr/bin/env python3
"""Aviso de Jeff a la persona del equipo de Expertos cuando un pase del bot
lleva 2 h de oficina sin respuesta (tramo 5, aprobado por Daniel el 27-oct).

Corre en el ERP (18.205.94.210), donde vive la cola de Jeff. Pide la lista al
servidor del chat (scripts/aviso_pases_sin_respuesta.js --json, que solo lee)
y encola UN WhatsApp interno por pase. Nunca le escribe al cliente.

A quién:
  - a la persona, si su número está en AVISO_PASES_DESTINOS
    (JSON {"<id_sub_usuario>": "593...@s.whatsapp.net"});
  - si no, al grupo del equipo (GROUP_JID_SOPORTE_IMPORTACIONES).

Variables:
  AVISO_PASES_SSH      comando ssh al servidor del chat (p. ej. "ssh -i KEY ubuntu@HOST")
  AVISO_PASES_CONFIG   id de la cuenta (por defecto 265)
  AVISO_PASES_DESTINOS ver arriba (opcional)
  GROUP_JID_SOPORTE_IMPORTACIONES  grupo del equipo
  JEFF_QUEUE_DIR       cola de Jeff (por defecto /tmp/jeff_queue)

Uso:
  python3 aviso_pases_jeff.py           # en seco: muestra qué avisaría
  python3 aviso_pases_jeff.py --enviar  # encola en Jeff

Cron sugerido (UTC; L-V 8:00-17:00 de Ecuador, cada 15 min; logs en ~/logs):
  */15 13-21 * * 1-5 cd /home/ubuntu/jeff && /usr/bin/python3 aviso_pases_jeff.py --enviar >> /home/ubuntu/logs/aviso_pases.log 2>&1
"""
import json
import os
import shlex
import subprocess
import sys
import time

ESTADO = os.path.expanduser(os.getenv("AVISO_PASES_ESTADO", "~/logs/aviso_pases_estado.json"))
COLA = os.getenv("JEFF_QUEUE_DIR", "/tmp/jeff_queue")
DIAS_ESTADO = 7


def leer_estado():
    try:
        with open(ESTADO, encoding="utf-8") as f:
            datos = json.load(f)
    except (OSError, ValueError):
        return {}
    limite = time.time() - DIAS_ESTADO * 86400
    return {k: v for k, v in datos.items() if v >= limite}


def guardar_estado(estado):
    os.makedirs(os.path.dirname(ESTADO), exist_ok=True)
    tmp = ESTADO + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(estado, f)
    os.replace(tmp, ESTADO)


def pedir_lista(config):
    ssh = os.getenv("AVISO_PASES_SSH")
    if not ssh:
        raise SystemExit("falta AVISO_PASES_SSH")
    remoto = f"cd /var/www/socket && sudo node scripts/aviso_pases_sin_respuesta.js --config {int(config)} --json"
    r = subprocess.run(shlex.split(ssh) + [remoto], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        # Un fallo NO es «0 pases»: se dice y se sale con error.
        raise SystemExit(f"no pude leer los pases: {r.stderr.strip()[:300]}")
    linea = [l for l in r.stdout.splitlines() if l.strip().startswith("[")]
    if not linea:
        raise SystemExit(f"respuesta sin lista: {r.stdout.strip()[:300]}")
    return json.loads(linea[-1])


def encolar(jid, texto, mentions=None):
    os.makedirs(COLA, exist_ok=True)
    p = os.path.join(COLA, f"aviso_pases_{int(time.time() * 1000)}_{os.getpid()}.json")
    datos = {"jid": jid, "text": texto}
    if mentions:
        datos["mentions"] = mentions
    with open(p + ".tmp", "w", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False)
    os.replace(p + ".tmp", p)


def main():
    enviar = "--enviar" in sys.argv
    config = os.getenv("AVISO_PASES_CONFIG", "265")
    destinos = json.loads(os.getenv("AVISO_PASES_DESTINOS", "{}") or "{}")
    grupo = os.getenv("GROUP_JID_SOPORTE_IMPORTACIONES", "")
    estado = leer_estado()
    avisos = pedir_lista(config)
    nuevos = [a for a in avisos if f"{a['config']}:{a['pase']}" not in estado]
    print(f"{time.strftime('%Y-%m-%d %H:%M')} · {len(avisos)} pases con 2 h sin respuesta · {len(nuevos)} sin avisar · {'ENCOLA' if enviar else 'en seco'}")
    for a in nuevos:
        jid = destinos.get(str(a.get("encargado")))
        if jid:
            destino, mentions = jid, None
        elif grupo:
            destino = grupo
            mentions = None
        else:
            print(f"  ✗ chat {a['chat']}: sin número de {a.get('nombre')} ni grupo del equipo")
            continue
        print(f"  → {a.get('nombre')} ({'DM' if jid else 'grupo'}) · chat {a['chat']} · {a['esperaMin']} min")
        if enviar:
            encolar(destino, a["texto"], mentions)
            estado[f"{a['config']}:{a['pase']}"] = time.time()
    if enviar:
        guardar_estado(estado)


if __name__ == "__main__":
    main()
