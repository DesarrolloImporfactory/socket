const { body, validationResult } = require('express-validator');

const validField = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ status: 'error', errors: errors.mapped() });
  }
  next();
};

exports.createUserValidation = [
  body('nombre').notEmpty().withMessage('Name is required!'),
  body('email')
    .notEmpty()
    .withMessage('Email cannot be empty!')
    .isEmail()
    .withMessage('Must be a valid email!'),
  body('con')
    .notEmpty()
    .withMessage('Password cannot be empty!')
    .isLength({ min: 5 })
    .withMessage('Password must be at least 6 characters long!'),
  body('usuario').notEmpty().withMessage('Usuaario cannot be empty!'),
  validField,
];

exports.loginValidation = [
  body('email')
    .notEmpty()
    .withMessage('Email cannot be empty!')
    .isEmail()
    .withMessage('Must be a valid email!'),
  body('con')
    .notEmpty()
    .withMessage('Password cannot be empty!')
    .isLength({ min: 4 })
    .withMessage('Password must be at least 6 characters long!'),
  validField,
];
