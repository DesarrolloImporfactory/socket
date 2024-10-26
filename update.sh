#!/bin/bash

# Función para mostrar mensaje de ayuda
show_help() {
    echo "Uso: $0 [--m 'mensaje de commit']"
    echo "  -m, --message 'mensaje de commit': Especifica el mensaje del commit."
    exit 1
}

# Verificar si se proporcionó el argumento --m o --message
if [ "$1" == "--m" ] || [ "$1" == "--message" ]; then
    # Obtener el mensaje de commit del siguiente argumento
    message="$2"
else
    show_help
fi

# Traer cambios desde el repositorio remoto
git pull
if [ $? -ne 0 ]; then
    echo "Error: 'git pull' falló."
    exit 1
fi

# Añadir todos los cambios al staging area
git add .
if [ $? -ne 0 ]; then
    echo "Error: 'git add' falló."
    exit 1
fi

# Hacer commit de los cambios con el mensaje personalizado
git commit -m "$message"
if [ $? -ne 0 ]; then
    echo "Error: 'git commit' falló."
    exit 1
fi

# Empujar los cambios al repositorio remoto
git push
if [ $? -ne 0 ]; then
    echo "Error: 'git push' falló."
    exit 1
fi

echo "Actualización completada con éxito."