CREATE DATABASE IF NOT EXISTS recubrimientos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE recubrimientos;

CREATE TABLE IF NOT EXISTS usuarios (
  id_usuario INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  rol ENUM('Administrador', 'Operador') NOT NULL DEFAULT 'Operador',
  estado ENUM('Activo', 'Inactivo') NOT NULL DEFAULT 'Activo',
  fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO usuarios (nombre, email, password_hash, rol, estado) VALUES
  ('Administrador', 'admin@recubrimientos.com', '$2b$12$Np994fk847eQY0DN1B.fcOSCIG0wsexK8rvXvpYNJ1C1J1A9Fp5fS', 'Administrador', 'Activo');

CREATE TABLE IF NOT EXISTS clientes (
  id_cliente INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(120) NOT NULL,
  identificacion VARCHAR(13) NOT NULL UNIQUE,
  telefono VARCHAR(20) NOT NULL,
  correo VARCHAR(160),
  direccion VARCHAR(255),
  notas TEXT,
  fecha_registro TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS materiales (
  id_material INT AUTO_INCREMENT PRIMARY KEY,
  codigo VARCHAR(20) NOT NULL UNIQUE,
  nombre VARCHAR(100) NOT NULL,
  tipo VARCHAR(60) NOT NULL,
  rendimiento_m2_gal DECIMAL(10,2) NOT NULL DEFAULT 35.00,
  precio_unitario DECIMAL(10,2) NOT NULL,
  unidad_medida VARCHAR(20) NOT NULL DEFAULT 'Galón'
);

CREATE TABLE IF NOT EXISTS material_categorias (
  id_categoria INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(60) NOT NULL UNIQUE,
  fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT IGNORE INTO material_categorias (nombre) VALUES
  ('Pintura'),
  ('Sellador'),
  ('Esmalte'),
  ('Impermeabilizante'),
  ('Accesorio');

CREATE TABLE IF NOT EXISTS inventario (
  id_inventario INT AUTO_INCREMENT PRIMARY KEY,
  id_material INT NOT NULL,
  stock_actual DECIMAL(10,2) NOT NULL DEFAULT 0,
  stock_minimo DECIMAL(10,2) NOT NULL DEFAULT 5,
  fecha_ultima_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (id_material) REFERENCES materiales(id_material) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id_movimiento INT AUTO_INCREMENT PRIMARY KEY,
  material_id INT NOT NULL,
  id_usuario INT,
  tipo ENUM('Entrada', 'Salida') NOT NULL,
  fecha DATE NOT NULL,
  cantidad DECIMAL(10,2) NOT NULL,
  referencia VARCHAR(120),
  notas TEXT,
  fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (material_id) REFERENCES materiales(id_material),
  FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS proyectos (
  id_proyecto INT AUTO_INCREMENT PRIMARY KEY,
  id_cliente INT NOT NULL,
  id_usuario INT NOT NULL,
  nombre_proyecto VARCHAR(150) NOT NULL,
  largo DECIMAL(10,2) NULL,
  area_m2 DECIMAL(10,2) NOT NULL,
  altura DECIMAL(10,2) NULL,
  tipo VARCHAR(80) NULL,
  descripcion TEXT NULL,
  estado ENUM('Pendiente', 'En proceso', 'Finalizado') NOT NULL DEFAULT 'Pendiente',
  costo_estimado DECIMAL(10,2) DEFAULT 0.00,
  fecha_inicio DATE,
  fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (id_cliente) REFERENCES clientes(id_cliente),
  FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
);

CREATE TABLE IF NOT EXISTS proyecto_materiales (
  id_detalle INT AUTO_INCREMENT PRIMARY KEY,
  id_proyecto INT NOT NULL,
  id_material INT NOT NULL,
  cantidad_calculada DECIMAL(10,2) NOT NULL,
  costo_subtotal DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto) ON DELETE CASCADE,
  FOREIGN KEY (id_material) REFERENCES materiales(id_material)
);

DELIMITER //

CREATE PROCEDURE sp_calcular_material_proyecto(
  IN p_id_proyecto INT,
  IN p_id_material INT
)
BEGIN
  DECLARE v_area DECIMAL(10,2);
  DECLARE v_rendimiento DECIMAL(10,2);
  DECLARE v_precio DECIMAL(10,2);
  DECLARE v_galones DECIMAL(10,2);
  DECLARE v_subtotal DECIMAL(10,2);

  SELECT area_m2 INTO v_area
  FROM proyectos
  WHERE id_proyecto = p_id_proyecto;

  SELECT rendimiento_m2_gal, precio_unitario
  INTO v_rendimiento, v_precio
  FROM materiales
  WHERE id_material = p_id_material;

  SET v_galones = CEIL(v_area / v_rendimiento);
  SET v_subtotal = v_galones * v_precio;

  INSERT INTO proyecto_materiales
    (id_proyecto, id_material, cantidad_calculada, costo_subtotal)
  VALUES
    (p_id_proyecto, p_id_material, v_galones, v_subtotal);

  UPDATE proyectos
  SET costo_estimado = (
    SELECT SUM(costo_subtotal)
    FROM proyecto_materiales
    WHERE id_proyecto = p_id_proyecto
  )
  WHERE id_proyecto = p_id_proyecto;
END //

DELIMITER ;
