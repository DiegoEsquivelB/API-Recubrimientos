CREATE DATABASE IF NOT EXISTS recubrimientos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE recubrimientos;

CREATE TABLE IF NOT EXISTS usuarios (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(120) NOT NULL,
  usuario VARCHAR(120) NOT NULL UNIQUE,
  contrasena VARCHAR(255) NOT NULL,
  rol ENUM('Administrador', 'Vendedor', 'Bodega') NOT NULL DEFAULT 'Vendedor',
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clientes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(160) NOT NULL,
  identificacion VARCHAR(40),
  telefono VARCHAR(30) NOT NULL,
  correo VARCHAR(160),
  ciudad VARCHAR(100),
  direccion VARCHAR(255),
  notas TEXT,
  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS materiales (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(160) NOT NULL,
  categoria VARCHAR(80) NOT NULL,
  unidad VARCHAR(40) NOT NULL,
  rendimiento DECIMAL(10,2) DEFAULT 0,
  costo DECIMAL(10,2) DEFAULT 0,
  stock_minimo DECIMAL(10,2) DEFAULT 0,
  marca VARCHAR(120),
  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS proyectos (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(180) NOT NULL,
  cliente_id INT UNSIGNED NOT NULL,
  estado ENUM('Pendiente', 'En proceso', 'Finalizado') NOT NULL DEFAULT 'Pendiente',
  fecha_inicio DATE,
  fecha_fin DATE,
  largo DECIMAL(10,2) NOT NULL,
  ancho DECIMAL(10,2) NOT NULL,
  altura DECIMAL(10,2) DEFAULT 0,
  tipo VARCHAR(100),
  presupuesto DECIMAL(12,2) DEFAULT 0,
  notas TEXT,
  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_proyectos_cliente FOREIGN KEY (cliente_id) REFERENCES clientes(id)
);

CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  material_id INT UNSIGNED NOT NULL,
  tipo ENUM('Entrada', 'Salida') NOT NULL,
  fecha DATE NOT NULL,
  cantidad DECIMAL(10,2) NOT NULL,
  referencia VARCHAR(160),
  notas TEXT,
  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_movimientos_material FOREIGN KEY (material_id) REFERENCES materiales(id)
);
