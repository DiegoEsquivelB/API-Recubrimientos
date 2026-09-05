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
  id_usuario INT NULL,
  nombre VARCHAR(120) NOT NULL,
  identificacion VARCHAR(13) NOT NULL UNIQUE,
  telefono VARCHAR(20) NOT NULL,
  correo VARCHAR(160) NOT NULL,
  direccion VARCHAR(255),
  notas TEXT,
  fecha_registro TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS material_categorias (
  id_categoria INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(60) NOT NULL UNIQUE,
  prefijo_codigo VARCHAR(10) NULL,
  fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS materiales (
  id_material INT AUTO_INCREMENT PRIMARY KEY,
  id_usuario INT NULL,
  id_categoria INT NULL,
  codigo VARCHAR(20) NOT NULL UNIQUE,
  nombre VARCHAR(100) NOT NULL,
  tipo VARCHAR(60) NOT NULL,
  rendimiento_m2_gal DECIMAL(10,2) NOT NULL DEFAULT 35.00,
  precio_unitario DECIMAL(10,2) NOT NULL,
  unidad_medida VARCHAR(20) NOT NULL DEFAULT 'Galón',
  descripcion TEXT NULL,
  FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY (id_categoria) REFERENCES material_categorias(id_categoria) ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT IGNORE INTO material_categorias (nombre, prefijo_codigo) VALUES
  ('Pintura', 'PIN'),
  ('Sellador', 'SEL'),
  ('Esmalte', 'ESM'),
  ('Impermeabilizante', 'IMP'),
  ('Accesorio', 'ACC');

CREATE TABLE IF NOT EXISTS inventario (
  id_inventario INT AUTO_INCREMENT PRIMARY KEY,
  id_usuario INT NULL,
  id_material INT NOT NULL,
  stock_actual DECIMAL(10,2) NOT NULL DEFAULT 0,
  stock_minimo DECIMAL(10,2) NOT NULL DEFAULT 5,
  fecha_ultima_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (id_material) REFERENCES materiales(id_material) ON DELETE CASCADE,
  FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL ON UPDATE CASCADE
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
  id_usuario INT NULL,
  id_proyecto INT NOT NULL,
  id_material INT NOT NULL,
  cantidad_calculada DECIMAL(10,2) NOT NULL,
  costo_subtotal DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto) ON DELETE CASCADE,
  FOREIGN KEY (id_material) REFERENCES materiales(id_material),
  FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE OR REPLACE VIEW vw_stock_materiales AS
SELECT
  m.id_material,
  m.codigo,
  m.nombre AS material,
  COALESCE(mc.nombre, m.tipo) AS categoria,
  m.unidad_medida,
  m.precio_unitario,
  i.stock_actual,
  i.stock_minimo,
  CASE
    WHEN i.stock_actual <= i.stock_minimo THEN 'Bajo'
    ELSE 'Normal'
  END AS estado_stock
FROM materiales m
LEFT JOIN material_categorias mc ON mc.id_categoria = m.id_categoria
LEFT JOIN inventario i ON i.id_material = m.id_material;

CREATE OR REPLACE VIEW vw_detalle_proyecto_materiales AS
SELECT
  p.id_proyecto,
  p.nombre_proyecto,
  c.nombre AS cliente,
  m.id_material,
  m.codigo,
  m.nombre AS material,
  COALESCE(mc.nombre, m.tipo) AS categoria,
  pm.cantidad_calculada,
  m.precio_unitario,
  pm.costo_subtotal
FROM proyectos p
JOIN clientes c ON c.id_cliente = p.id_cliente
JOIN proyecto_materiales pm ON pm.id_proyecto = p.id_proyecto
JOIN materiales m ON m.id_material = pm.id_material
LEFT JOIN material_categorias mc ON mc.id_categoria = m.id_categoria;

CREATE OR REPLACE VIEW vw_resumen_proyectos AS
SELECT
  p.id_proyecto,
  p.nombre_proyecto,
  c.nombre AS cliente,
  u.nombre AS responsable,
  p.estado,
  p.fecha_inicio,
  p.costo_estimado,
  p.area_m2
FROM proyectos p
JOIN clientes c ON c.id_cliente = p.id_cliente
JOIN usuarios u ON u.id_usuario = p.id_usuario;

CREATE OR REPLACE VIEW vw_dashboard_resumen AS
SELECT
  (SELECT COUNT(*) FROM proyectos) AS total_proyectos,
  (SELECT COUNT(*) FROM materiales) AS total_materiales,
  (SELECT COALESCE(SUM(stock_actual), 0) FROM inventario) AS stock_total,
  (SELECT COALESCE(SUM(costo_estimado), 0) FROM proyectos) AS costo_total_proyectos;

CREATE OR REPLACE VIEW vw_usuarios_activos AS
SELECT
  id_usuario,
  nombre,
  email,
  rol,
  estado,
  fecha_creacion
FROM usuarios
WHERE estado = 'Activo';

CREATE OR REPLACE VIEW vw_usuarios_por_rol AS
SELECT
  rol,
  COUNT(*) AS total_usuarios
FROM usuarios
GROUP BY rol;

CREATE OR REPLACE VIEW vw_clientes_activos AS
SELECT
  id_cliente,
  nombre,
  identificacion,
  telefono,
  correo,
  direccion
FROM clientes;

CREATE OR REPLACE VIEW vw_materiales_por_categoria AS
SELECT
  COALESCE(mc.nombre, m.tipo) AS categoria,
  COUNT(*) AS total_materiales,
  ROUND(AVG(m.precio_unitario), 2) AS precio_promedio
FROM materiales m
LEFT JOIN material_categorias mc ON mc.id_categoria = m.id_categoria
GROUP BY COALESCE(mc.nombre, m.tipo);

CREATE OR REPLACE VIEW vw_materiales_activos AS
SELECT
  m.id_material,
  m.codigo,
  m.nombre,
  COALESCE(mc.nombre, m.tipo) AS tipo,
  m.precio_unitario,
  m.unidad_medida,
  m.rendimiento_m2_gal
FROM materiales m
LEFT JOIN material_categorias mc ON mc.id_categoria = m.id_categoria;

CREATE OR REPLACE VIEW vw_movimientos_recientes AS
SELECT
  mi.id_movimiento,
  mi.material_id,
  m.nombre AS material,
  mi.tipo,
  mi.fecha,
  mi.cantidad,
  mi.referencia,
  mi.notas
FROM movimientos_inventario mi
JOIN materiales m ON m.id_material = mi.material_id
ORDER BY mi.fecha DESC, mi.id_movimiento DESC;

CREATE OR REPLACE VIEW vw_proyectos_activos AS
SELECT
  p.id_proyecto,
  p.nombre_proyecto,
  p.estado,
  p.fecha_inicio,
  p.costo_estimado,
  c.nombre AS cliente
FROM proyectos p
JOIN clientes c ON c.id_cliente = p.id_cliente
WHERE p.estado IN ('Pendiente', 'En proceso');

CREATE OR REPLACE VIEW vw_proyectos_por_estado AS
SELECT
  estado,
  COUNT(*) AS total_proyectos,
  ROUND(AVG(costo_estimado), 2) AS costo_promedio
FROM proyectos
GROUP BY estado;

CREATE OR REPLACE VIEW vw_resumen_proyectos_reportes AS
SELECT
  p.id_proyecto,
  p.nombre_proyecto,
  c.nombre AS cliente,
  p.estado,
  p.costo_estimado,
  p.fecha_inicio
FROM proyectos p
JOIN clientes c ON c.id_cliente = p.id_cliente;

CREATE OR REPLACE VIEW vw_consumo_total_por_material AS
SELECT
  pm.id_material,
  m.nombre AS material,
  SUM(pm.cantidad_calculada) AS total_consumido,
  SUM(pm.costo_subtotal) AS total_costo
FROM proyecto_materiales pm
JOIN materiales m ON m.id_material = pm.id_material
GROUP BY pm.id_material, m.nombre;

CREATE OR REPLACE VIEW vw_resumen_proyectos_recientes AS
SELECT
  p.id_proyecto,
  p.nombre_proyecto,
  c.nombre AS cliente,
  p.estado,
  p.fecha_inicio,
  p.costo_estimado
FROM proyectos p
JOIN clientes c ON c.id_cliente = p.id_cliente
ORDER BY p.fecha_creacion DESC
LIMIT 10;

CREATE OR REPLACE VIEW vw_resumen_materiales_disponibles AS
SELECT
  m.id_material,
  m.nombre,
  m.tipo,
  COALESCE(i.stock_actual, 0) AS stock_disponible,
  m.precio_unitario
FROM materiales m
LEFT JOIN inventario i ON i.id_material = m.id_material;

CREATE TABLE IF NOT EXISTS sesiones (
  id_sesion INT AUTO_INCREMENT PRIMARY KEY,
  id_usuario INT NOT NULL,
  token VARCHAR(255) NOT NULL,
  fecha_inicio DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_expiracion DATETIME NULL,
  estado ENUM('Activa', 'Cerrada') NOT NULL DEFAULT 'Activa',
  FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auditoria_operaciones (
  id_auditoria INT AUTO_INCREMENT PRIMARY KEY,
  modulo VARCHAR(50) NOT NULL,
  accion ENUM('READ', 'INSERT', 'UPDATE', 'DELETE') NOT NULL,
  id_registro INT NULL,
  usuario_responsable INT NULL,
  fecha DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  detalle TEXT NOT NULL,
  FOREIGN KEY (usuario_responsable) REFERENCES usuarios(id_usuario) ON DELETE SET NULL ON UPDATE CASCADE
);

DELIMITER $$

CREATE TRIGGER trg_aud_usuarios_insert
AFTER INSERT ON usuarios
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'autenticacion',
    'INSERT',
    NEW.id_usuario,
    NEW.id_usuario,
    CONCAT('Usuario autenticado/creado: nombre=', NEW.nombre, ', email=', NEW.email, ', rol=', NEW.rol)
  );
END$$

CREATE TRIGGER trg_aud_usuarios_update
AFTER UPDATE ON usuarios
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'autenticacion',
    'UPDATE',
    NEW.id_usuario,
    NEW.id_usuario,
    CONCAT('Usuario actualizado: nombre=', NEW.nombre, ', email=', NEW.email, ', estado=', NEW.estado)
  );
END$$

CREATE TRIGGER trg_aud_usuarios_delete
AFTER DELETE ON usuarios
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'autenticacion',
    'DELETE',
    OLD.id_usuario,
    @usuario_responsable,
    CONCAT('Usuario eliminado: nombre=', OLD.nombre, ', email=', OLD.email)
  );
END$$

CREATE TRIGGER trg_aud_sesiones_insert
AFTER INSERT ON sesiones
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'autenticacion',
    'INSERT',
    NEW.id_sesion,
    NEW.id_usuario,
    CONCAT('Sesión creada: token=', NEW.token, ', estado=', NEW.estado)
  );
END$$

CREATE TRIGGER trg_aud_sesiones_update
AFTER UPDATE ON sesiones
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'autenticacion',
    'UPDATE',
    NEW.id_sesion,
    NEW.id_usuario,
    CONCAT('Sesión actualizada: token=', NEW.token, ', estado=', NEW.estado)
  );
END$$

CREATE TRIGGER trg_aud_sesiones_delete
AFTER DELETE ON sesiones
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'autenticacion',
    'DELETE',
    OLD.id_sesion,
    OLD.id_usuario,
    CONCAT('Sesión eliminada: token=', OLD.token)
  );
END$$

CREATE TRIGGER trg_aud_clientes_insert
AFTER INSERT ON clientes
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'clientes',
    'INSERT',
    NEW.id_cliente,
    NEW.id_usuario,
    CONCAT('Cliente creado: nombre=', NEW.nombre, ', identificacion=', NEW.identificacion)
  );
END$$

CREATE TRIGGER trg_aud_clientes_update
AFTER UPDATE ON clientes
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'clientes',
    'UPDATE',
    NEW.id_cliente,
    NEW.id_usuario,
    CONCAT('Cliente actualizado: nombre=', NEW.nombre, ', telefono=', NEW.telefono)
  );
END$$

CREATE TRIGGER trg_aud_clientes_delete
AFTER DELETE ON clientes
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'clientes',
    'DELETE',
    OLD.id_cliente,
    OLD.id_usuario,
    CONCAT('Cliente eliminado: nombre=', OLD.nombre, ', identificacion=', OLD.identificacion)
  );
END$$

CREATE TRIGGER trg_aud_materiales_insert
AFTER INSERT ON materiales
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'materiales',
    'INSERT',
    NEW.id_material,
    NEW.id_usuario,
    CONCAT('Material creado: codigo=', NEW.codigo, ', nombre=', NEW.nombre, ', tipo=', NEW.tipo)
  );
END$$

CREATE TRIGGER trg_aud_materiales_update
AFTER UPDATE ON materiales
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'materiales',
    'UPDATE',
    NEW.id_material,
    NEW.id_usuario,
    CONCAT('Material actualizado: codigo=', NEW.codigo, ', nombre=', NEW.nombre, ', precio=', NEW.precio_unitario)
  );
END$$

CREATE TRIGGER trg_aud_materiales_delete
AFTER DELETE ON materiales
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'materiales',
    'DELETE',
    OLD.id_material,
    OLD.id_usuario,
    CONCAT('Material eliminado: codigo=', OLD.codigo, ', nombre=', OLD.nombre)
  );
END$$

CREATE TRIGGER trg_aud_inventario_insert
AFTER INSERT ON inventario
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'inventario',
    'INSERT',
    NEW.id_inventario,
    NEW.id_usuario,
    CONCAT('Inventario creado: id_material=', NEW.id_material, ', stock_actual=', NEW.stock_actual)
  );
END$$

CREATE TRIGGER trg_aud_inventario_update
AFTER UPDATE ON inventario
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'inventario',
    'UPDATE',
    NEW.id_inventario,
    NEW.id_usuario,
    CONCAT('Inventario actualizado: id_material=', NEW.id_material, ', stock_actual=', NEW.stock_actual)
  );
END$$

CREATE TRIGGER trg_aud_inventario_delete
AFTER DELETE ON inventario
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'inventario',
    'DELETE',
    OLD.id_inventario,
    OLD.id_usuario,
    CONCAT('Inventario eliminado: id_material=', OLD.id_material, ', stock_actual=', OLD.stock_actual)
  );
END$$

CREATE TRIGGER trg_aud_movimientos_inventario_insert
AFTER INSERT ON movimientos_inventario
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'inventario',
    'INSERT',
    NEW.id_movimiento,
    NEW.id_usuario,
    CONCAT('Movimiento de inventario: tipo=', NEW.tipo, ', cantidad=', NEW.cantidad, ', referencia=', COALESCE(NEW.referencia, 'N/A'))
  );
END$$

CREATE TRIGGER trg_aud_movimientos_inventario_update
AFTER UPDATE ON movimientos_inventario
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'inventario',
    'UPDATE',
    NEW.id_movimiento,
    NEW.id_usuario,
    CONCAT('Movimiento actualizado: tipo=', NEW.tipo, ', cantidad=', NEW.cantidad)
  );
END$$

CREATE TRIGGER trg_aud_movimientos_inventario_delete
AFTER DELETE ON movimientos_inventario
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'inventario',
    'DELETE',
    OLD.id_movimiento,
    OLD.id_usuario,
    CONCAT('Movimiento eliminado: tipo=', OLD.tipo, ', cantidad=', OLD.cantidad)
  );
END$$

CREATE TRIGGER trg_aud_proyectos_insert
AFTER INSERT ON proyectos
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'proyectos',
    'INSERT',
    NEW.id_proyecto,
    NEW.id_usuario,
    CONCAT('Proyecto creado: nombre=', NEW.nombre_proyecto, ', estado=', NEW.estado, ', costo=', NEW.costo_estimado)
  );
END$$

CREATE TRIGGER trg_aud_proyectos_update
AFTER UPDATE ON proyectos
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'proyectos',
    'UPDATE',
    NEW.id_proyecto,
    NEW.id_usuario,
    CONCAT('Proyecto actualizado: nombre=', NEW.nombre_proyecto, ', estado=', NEW.estado, ', costo=', NEW.costo_estimado)
  );
END$$

CREATE TRIGGER trg_aud_proyectos_delete
AFTER DELETE ON proyectos
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'proyectos',
    'DELETE',
    OLD.id_proyecto,
    OLD.id_usuario,
    CONCAT('Proyecto eliminado: nombre=', OLD.nombre_proyecto)
  );
END$$

CREATE TRIGGER trg_aud_proyecto_materiales_insert
AFTER INSERT ON proyecto_materiales
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'proyectos',
    'INSERT',
    NEW.id_detalle,
    NEW.id_usuario,
    CONCAT('Material asignado al proyecto: id_proyecto=', NEW.id_proyecto, ', id_material=', NEW.id_material, ', cantidad=', NEW.cantidad_calculada)
  );
END$$

CREATE TRIGGER trg_aud_proyecto_materiales_update
AFTER UPDATE ON proyecto_materiales
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'proyectos',
    'UPDATE',
    NEW.id_detalle,
    NEW.id_usuario,
    CONCAT('Material del proyecto actualizado: id_proyecto=', NEW.id_proyecto, ', id_material=', NEW.id_material, ', subtotal=', NEW.costo_subtotal)
  );
END$$

CREATE TRIGGER trg_aud_proyecto_materiales_delete
AFTER DELETE ON proyecto_materiales
FOR EACH ROW
BEGIN
  INSERT INTO auditoria_operaciones (modulo, accion, id_registro, usuario_responsable, detalle)
  VALUES (
    'proyectos',
    'DELETE',
    OLD.id_detalle,
    OLD.id_usuario,
    CONCAT('Material removido del proyecto: id_proyecto=', OLD.id_proyecto, ', id_material=', OLD.id_material)
  );
END$$

DELIMITER ;

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
