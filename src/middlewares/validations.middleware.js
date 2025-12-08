const { body, validationResult } = require('express-validator');

// Middleware que maneja los errores de validación
const validField = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'fail',
      errors: errors.mapped(),
    });
  }
  next();
};

// Validación para crear usuario (registro)
exports.createUserValidation = [
  body('nombre').notEmpty().withMessage('El nombre es obligatorio.'),
  body('usuario')
    .notEmpty()
    .withMessage('El nombre de usuario es obligatorio.'),
  body('password')
    .notEmpty()
    .withMessage('La contraseña es obligatoria.')
    .isLength({ min: 6 })
    .withMessage('La contraseña debe tener al menos 6 caracteres.'),
  body('email')
    .notEmpty()
    .withMessage('El correo electrónico es obligatorio.')
    .isEmail()
    .withMessage('Debe ser un correo electrónico válido.'),
  body('nombre_encargado')
    .notEmpty()
    .withMessage('El nombre del encargado es obligatorio.'),
  validField,
];

// Validación para login (si luego se usa email + password)
exports.loginValidation = [
  body('email')
    .notEmpty()
    .withMessage('El correo electrónico es obligatorio.')
    .isEmail()
    .withMessage('Debe ser un correo electrónico válido.'),
  body('password')
    .notEmpty()
    .withMessage('La contraseña es obligatoria.')
    .isLength({ min: 6 })
    .withMessage('La contraseña debe tener al menos 6 caracteres.'),
  validField,
];

exports.validCrearProducto = [
  body('nombre')
    .notEmpty()
    .withMessage('El nombre del producto es obligatorio.'),
  body('precio')
    .notEmpty()
    .withMessage('El precio del producto es obligatorio.'),
  body('descripcion')
    .notEmpty()
    .withMessage('La descripción del producto es obligatoria.'),
  body('tipo_membresia')
    .notEmpty()
    .withMessage('El tipo de membresía es obligatorio.'),
  validField,
];
