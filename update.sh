#!/bin/bash

# Función para mostrar mensaje de ayuda
show_help() {
    echo ""
    echo "Uso: $0 -m 'mensaje de commit' [-f archivo1 archivo2 ...]"
    echo ""
    echo "  -m, --message  'mensaje'   Mensaje del commit (requerido)"
    echo "  -f, --files    archivo(s)  Archivos específicos a subir (opcional)"
    echo "                             Si se omite, se suben todos los cambios."
    echo ""
    echo "Ejemplos:"
    echo "  $0 -m 'fix bug'                            # sube todo"
    echo "  $0 -m 'update controller' -f Controllers/Pedidos.php"
    echo "  $0 -m 'update views' -f Views/pedidos.php Views/home.php"
    echo ""
    exit 1
}

message=""
files=()

# Parsear argumentos
while [[ $# -gt 0 ]]; do
    case "$1" in
        -m|--message)
            message="$2"
            shift 2
            ;;
        -f|--files)
            shift
            while [[ $# -gt 0 && "$1" != -* ]]; do
                files+=("$1")
                shift
            done
            ;;
        -h|--help)
            show_help
            ;;
        *)
            echo "Argumento desconocido: $1"
            show_help
            ;;
    esac
done

# Validar que se proporcionó el mensaje
if [ -z "$message" ]; then
    echo "Error: Se requiere un mensaje de commit (-m)."
    show_help
fi

# Mostrar estado actual
echo ""
echo "=== Estado del repositorio ==="
git status --short
echo ""

# Traer cambios desde el repositorio remoto
echo ">>> Ejecutando git pull..."
git pull
if [ $? -ne 0 ]; then
    echo "Error: 'git pull' falló."
    exit 1
fi

# Añadir archivos al staging area
if [ ${#files[@]} -gt 0 ]; then
    echo ">>> Añadiendo archivos específicos:"
    for f in "${files[@]}"; do
        echo "    - $f"
        git add "$f"
        if [ $? -ne 0 ]; then
            echo "Error: No se pudo añadir '$f'."
            exit 1
        fi
    done
else
    echo ">>> Añadiendo todos los cambios..."
    git add .
    if [ $? -ne 0 ]; then
        echo "Error: 'git add' falló."
        exit 1
    fi
fi

# Hacer commit de los cambios con el mensaje personalizado
echo ">>> Haciendo commit: \"$message\""
git commit -m "$message"
if [ $? -ne 0 ]; then
    echo "Error: 'git commit' falló."
    exit 1
fi

# Empujar los cambios al repositorio remoto
echo ">>> Subiendo cambios al repositorio remoto..."
git push
if [ $? -ne 0 ]; then
    echo "Error: 'git push' falló."
    exit 1
fi

echo ""
echo "✔ Actualización completada con éxito."