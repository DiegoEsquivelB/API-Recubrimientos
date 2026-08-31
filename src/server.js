const path = require('node:path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || 'recubrimientos',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 10
});

async function ensureDefaultAdminUser() {
  await pool.execute(
    `INSERT IGNORE INTO usuarios (nombre, email, password_hash, rol, estado)
     VALUES (?, ?, ?, ?, ?)`,
    [
      'Administrador',
      'admin@recubrimientos.com',
      '$2b$12$Np994fk847eQY0DN1B.fcOSCIG0wsexK8rvXvpYNJ1C1J1A9Fp5fS',
      'Administrador',
      'Activo'
    ]
  );
}

const DEFAULT_MATERIAL_CATEGORIES = ['Pintura', 'Sellador', 'Esmalte', 'Impermeabilizante', 'Accesorio'];

async function ensureMaterialCategorySupport() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS material_categorias (
      id_categoria INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(60) NOT NULL UNIQUE,
      fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  for (const category of DEFAULT_MATERIAL_CATEGORIES) {
    await pool.execute('INSERT IGNORE INTO material_categorias (nombre) VALUES (?)', [category]);
  }

  try {
    await pool.query('ALTER TABLE materiales MODIFY tipo VARCHAR(60) NOT NULL');
  } catch (_error) {
    // If the column is already compatible or the DB user cannot alter it, the API can still use existing categories.
  }
}

async function ensureInventorySupport() {
  await pool.query(`
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
    )
  `);

  try {
    await pool.query('ALTER TABLE movimientos_inventario ADD COLUMN id_usuario INT NULL');
  } catch (_error) {
    // Existing installations may already have this column.
  }

  try {
    await pool.query('ALTER TABLE movimientos_inventario ADD CONSTRAINT fk_movimientos_usuarios FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL');
  } catch (_error) {
    // Existing installations may already have this foreign key or lack privileges to add it.
  }

  try {
    await pool.query('ALTER TABLE inventario MODIFY stock_actual DECIMAL(10,2) NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE inventario MODIFY stock_minimo DECIMAL(10,2) NOT NULL DEFAULT 5');
  } catch (_error) {
    // Existing installations can still work if the DB user cannot alter column metadata.
  }
}

async function applyInventoryDelta(connection, materialId, tipo, cantidad, direction = 1) {
  const normalizedType = String(tipo || '').toLowerCase();
  const movementQuantity = Number(cantidad);
  if (!materialId || !Number.isFinite(movementQuantity) || movementQuantity <= 0) {
    const error = new Error('Material y cantidad válidos son obligatorios.');
    error.statusCode = 400;
    throw error;
  }

  const signedQuantity = normalizedType === 'salida'
    ? -movementQuantity * direction
    : movementQuantity * direction;

  const [inventoryRows] = await connection.execute(
    'SELECT stock_actual FROM inventario WHERE id_material = ? FOR UPDATE',
    [materialId]
  );

  if (!inventoryRows[0]) {
    await connection.execute(
      'INSERT INTO inventario (id_material, stock_actual, stock_minimo) VALUES (?, 0, 5)',
      [materialId]
    );
  }

  const [currentRows] = await connection.execute(
    'SELECT stock_actual FROM inventario WHERE id_material = ? FOR UPDATE',
    [materialId]
  );
  const currentStock = Number(currentRows[0]?.stock_actual || 0);
  const nextStock = currentStock + signedQuantity;

  if (nextStock < 0) {
    const error = new Error('No hay existencia suficiente para registrar esta salida.');
    error.statusCode = 409;
    throw error;
  }

  await connection.execute(
    'UPDATE inventario SET stock_actual = ? WHERE id_material = ?',
    [nextStock, materialId]
  );
}

app.use(cors({
  origin: [
    'http://127.0.0.1:5500',
    'http://localhost:5500'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.get('/', (_request, response) => {
  response.json({
    name: 'API Recubrimientos Diego S.A.',
    status: 'online',
    health: '/api/health',
    endpoints: [
      'POST /api/auth/login',
      'GET|POST /api/clientes',
      'GET|POST /api/materiales',
      'GET|POST /api/proyectos',
      'GET|POST /api/inventario/movimientos'
    ]
  });
});

app.get('/api/health', async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    response.json({ ok: true, database: 'connected' });
  } catch (_error) {
    response.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.post('/api/auth/login', async (request, response) => {
  const { usuario, contrasena } = request.body;
  if (!usuario || !contrasena) return response.status(400).json({ message: 'Usuario y contraseña son obligatorios.' });
  try {
    await ensureDefaultAdminUser();
    const [rows] = await pool.execute(
      `SELECT id_usuario, nombre, email, password_hash, rol, estado
       FROM usuarios
       WHERE email = ? AND estado = 'Activo'
       LIMIT 1`,
      [usuario]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(contrasena, user.password_hash))) {
      return response.status(401).json({ message: 'Las credenciales no son válidas.' });
    }
    response.json({
      user: {
        id: user.id_usuario,
        id_usuario: user.id_usuario,
        nombre: user.nombre,
        usuario: user.email,
        email: user.email,
        rol: user.rol,
        estado: user.estado
      }
    });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar la base de datos.' });
  }
});

app.post('/api/auth/usuarios', async (request, response) => {
  const { nombre, usuario, email, contrasena, rol = 'Operador' } = request.body;
  const userEmail = email || usuario;
  if (!nombre || !usuario || !contrasena) return response.status(400).json({ message: 'Nombre, usuario y contraseña son obligatorios.' });
  try {
    const hash = await bcrypt.hash(contrasena, 12);
    const [result] = await pool.execute(
      'INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)',
      [nombre, userEmail, hash, rol]
    );
    response.status(201).json({ id: result.insertId, id_usuario: result.insertId, message: 'Usuario creado correctamente.' });
  } catch (error) {
    response.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: 'No fue posible crear el usuario.' });
  }
});

app.get('/api/usuarios', async (_request, response) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        id_usuario AS id,
        id_usuario,
        nombre,
        email AS correo,
        email,
        rol,
        estado,
        fecha_creacion
      FROM usuarios
      ORDER BY nombre ASC
    `);
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar los usuarios.' });
  }
});

app.get('/api/clientes', async (_request, response) => {
  try {
    const [rows] = await pool.query('SELECT * FROM clientes ORDER BY id_cliente DESC');
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar los clientes.' });
  }
});

app.get('/api/clientes/:id', async (request, response) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM clientes WHERE id_cliente = ?', [request.params.id]);
    if (!rows[0]) return response.status(404).json({ message: 'Cliente no encontrado.' });
    response.json(rows[0]);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar el cliente.' });
  }
});

app.post('/api/clientes', async (request, response) => {
  const { nombre, identificacion, telefono, correo, direccion, notas } = request.body;
  if (!nombre || !identificacion || !telefono) return response.status(400).json({ message: 'Nombre, identificación y teléfono son obligatorios.' });
  try {
    const [result] = await pool.execute(
      'INSERT INTO clientes (nombre, identificacion, telefono, correo, direccion, notas) VALUES (?, ?, ?, ?, ?, ?)',
      [nombre, identificacion, telefono, correo || null, direccion || null, notas || null]
    );
    response.status(201).json({ id_cliente: result.insertId, message: 'Cliente guardado correctamente.' });
  } catch (error) {
    response.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({
      message: error.code === 'ER_DUP_ENTRY'
        ? 'La identificación ya está registrada.'
        : 'No fue posible guardar el cliente.'
    });
  }
});

app.put('/api/clientes/:id', async (request, response) => {
  const { nombre, identificacion, telefono, correo, direccion, notas } = request.body;
  if (!nombre || !identificacion || !telefono) return response.status(400).json({ message: 'Nombre, identificación y teléfono son obligatorios.' });
  try {
    const [result] = await pool.execute(
      `UPDATE clientes
       SET nombre = ?, identificacion = ?, telefono = ?, correo = ?, direccion = ?, notas = ?
       WHERE id_cliente = ?`,
      [nombre, identificacion, telefono, correo || null, direccion || null, notas || null, request.params.id]
    );
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Cliente no encontrado.' });
    response.json({ message: 'Cliente actualizado correctamente.' });
  } catch (error) {
    response.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({
      message: error.code === 'ER_DUP_ENTRY'
        ? 'La identificación ya está registrada.'
        : 'No fue posible actualizar el cliente.'
    });
  }
});

app.delete('/api/clientes/:id', async (request, response) => {
  try {
    const [result] = await pool.execute('DELETE FROM clientes WHERE id_cliente = ?', [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Cliente no encontrado.' });
    response.json({ message: 'Cliente eliminado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible eliminar el cliente.' });
  }
});

app.get('/api/materiales', async (_request, response) => {
  try {
    await ensureMaterialCategorySupport();
    const [rows] = await pool.query(`
      SELECT
        m.id_material AS id,
        m.id_material,
        m.codigo,
        m.nombre,
        m.tipo AS categoria,
        m.tipo,
        m.unidad_medida AS unidad,
        m.unidad_medida,
        m.rendimiento_m2_gal AS rendimiento,
        m.rendimiento_m2_gal,
        m.precio_unitario AS costo,
        m.precio_unitario,
        COALESCE(i.stock_minimo, 0) AS stock_minimo
      FROM materiales m
      LEFT JOIN inventario i ON i.id_material = m.id_material
      ORDER BY m.id_material DESC
    `);
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar los materiales.' });
  }
});

app.get('/api/materiales/categorias', async (_request, response) => {
  try {
    await ensureMaterialCategorySupport();
    const [rows] = await pool.query('SELECT id_categoria AS id, nombre FROM material_categorias ORDER BY nombre ASC');
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar las categorías.' });
  }
});

app.post('/api/materiales/categorias', async (request, response) => {
  const nombre = String(request.body.nombre || '').trim();
  if (!nombre) return response.status(400).json({ message: 'El nombre de la categoría es obligatorio.' });

  try {
    await ensureMaterialCategorySupport();
    const [result] = await pool.execute('INSERT INTO material_categorias (nombre) VALUES (?)', [nombre]);
    response.status(201).json({ id: result.insertId, nombre, message: 'Categoría guardada correctamente.' });
  } catch (error) {
    response.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({
      message: error.code === 'ER_DUP_ENTRY'
        ? 'La categoría ya existe.'
        : 'No fue posible guardar la categoría.'
    });
  }
});

app.put('/api/materiales/categorias/:id', async (request, response) => {
  const nombre = String(request.body.nombre || '').trim();
  if (!nombre) return response.status(400).json({ message: 'El nombre de la categoría es obligatorio.' });

  const connection = await pool.getConnection();
  try {
    await ensureMaterialCategorySupport();
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT nombre FROM material_categorias WHERE id_categoria = ?', [request.params.id]);
    if (!rows[0]) {
      await connection.rollback();
      return response.status(404).json({ message: 'Categoría no encontrada.' });
    }

    const previousName = rows[0].nombre;
    await connection.execute('UPDATE material_categorias SET nombre = ? WHERE id_categoria = ?', [nombre, request.params.id]);
    await connection.execute('UPDATE materiales SET tipo = ? WHERE tipo = ?', [nombre, previousName]);
    await connection.commit();
    response.json({ message: 'Categoría actualizada correctamente.' });
  } catch (error) {
    await connection.rollback();
    response.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({
      message: error.code === 'ER_DUP_ENTRY'
        ? 'La categoría ya existe.'
        : 'No fue posible actualizar la categoría.'
    });
  } finally {
    connection.release();
  }
});

app.delete('/api/materiales/categorias/:id', async (request, response) => {
  try {
    await ensureMaterialCategorySupport();
    const [rows] = await pool.execute('SELECT nombre FROM material_categorias WHERE id_categoria = ?', [request.params.id]);
    if (!rows[0]) return response.status(404).json({ message: 'Categoría no encontrada.' });

    const [usedRows] = await pool.execute('SELECT COUNT(*) AS total FROM materiales WHERE tipo = ?', [rows[0].nombre]);
    if (Number(usedRows[0].total) > 0) {
      return response.status(409).json({ message: 'No se puede eliminar la categoría porque tiene materiales asociados.' });
    }

    await pool.execute('DELETE FROM material_categorias WHERE id_categoria = ?', [request.params.id]);
    response.json({ message: 'Categoría eliminada correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible eliminar la categoría.' });
  }
});

app.get('/api/materiales/:id', async (request, response) => {
  try {
    await ensureMaterialCategorySupport();
    const [rows] = await pool.execute(`
      SELECT
        m.id_material AS id,
        m.id_material,
        m.codigo,
        m.nombre,
        m.tipo AS categoria,
        m.tipo,
        m.unidad_medida AS unidad,
        m.unidad_medida,
        m.rendimiento_m2_gal AS rendimiento,
        m.rendimiento_m2_gal,
        m.precio_unitario AS costo,
        m.precio_unitario,
        COALESCE(i.stock_minimo, 0) AS stock_minimo
      FROM materiales m
      LEFT JOIN inventario i ON i.id_material = m.id_material
      WHERE m.id_material = ?
    `, [request.params.id]);
    if (!rows[0]) return response.status(404).json({ message: 'Material no encontrado.' });
    response.json(rows[0]);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar el material.' });
  }
});

app.post('/api/materiales', async (request, response) => {
  const {
    codigo,
    nombre,
    categoria,
    tipo,
    unidad,
    unidad_medida,
    rendimiento,
    rendimiento_m2_gal,
    costo,
    precio_unitario,
    stock_minimo,
    registrar_inventario,
    stock_inicial,
    referencia_inventario
  } = request.body;
  const materialTipo = categoria || tipo;
  const unidadMedida = unidad || unidad_medida || 'Galón';
  const rendimientoMaterial = rendimiento || rendimiento_m2_gal || 35;
  const precioUnitario = costo || precio_unitario || 0;
  const stockMinimo = stock_minimo || 0;
  const shouldRegisterInventory = ['1', 'true', 'on', true, 1].includes(registrar_inventario);
  const initialStock = Number(stock_inicial || 0);

  if (!codigo || !nombre || !materialTipo || !unidadMedida) {
    return response.status(400).json({ message: 'Código, nombre, categoría y unidad son obligatorios.' });
  }

  if (shouldRegisterInventory && (!Number.isFinite(initialStock) || initialStock <= 0)) {
    return response.status(400).json({ message: 'La cantidad inicial debe ser mayor a cero.' });
  }

  await ensureMaterialCategorySupport();
  await ensureInventorySupport();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT IGNORE INTO material_categorias (nombre) VALUES (?)', [materialTipo]);
    const [result] = await connection.execute(
      'INSERT INTO materiales (codigo, nombre, tipo, rendimiento_m2_gal, precio_unitario, unidad_medida) VALUES (?, ?, ?, ?, ?, ?)',
      [codigo, nombre, materialTipo, rendimientoMaterial, precioUnitario, unidadMedida]
    );
    await connection.execute(
      'INSERT INTO inventario (id_material, stock_actual, stock_minimo) VALUES (?, ?, ?)',
      [result.insertId, shouldRegisterInventory ? initialStock : 0, stockMinimo]
    );

    if (shouldRegisterInventory) {
      await connection.execute(
        'INSERT INTO movimientos_inventario (material_id, tipo, fecha, cantidad, referencia, notas) VALUES (?, ?, CURDATE(), ?, ?, ?)',
        [result.insertId, 'Entrada', initialStock, referencia_inventario || 'Inventario inicial', 'Registro creado desde materiales']
      );
    }

    await connection.commit();
    response.status(201).json({
      id: result.insertId,
      message: shouldRegisterInventory
        ? 'Material guardado y entrada inicial registrada correctamente.'
        : 'Material guardado correctamente.'
    });
  } catch (error) {
    await connection.rollback();
    response.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({
      message: error.code === 'ER_DUP_ENTRY'
        ? 'El código del material ya está registrado.'
        : 'No fue posible guardar el material.'
    });
  } finally {
    connection.release();
  }
});

app.put('/api/materiales/:id', async (request, response) => {
  const { codigo, nombre, categoria, tipo, unidad, unidad_medida, rendimiento, rendimiento_m2_gal, costo, precio_unitario, stock_minimo } = request.body;
  const materialTipo = categoria || tipo;
  const unidadMedida = unidad || unidad_medida || 'Galón';
  const rendimientoMaterial = rendimiento || rendimiento_m2_gal || 35;
  const precioUnitario = costo || precio_unitario || 0;
  const stockMinimo = stock_minimo || 0;

  if (!codigo || !nombre || !materialTipo || !unidadMedida) {
    return response.status(400).json({ message: 'Código, nombre, categoría y unidad son obligatorios.' });
  }

  await ensureMaterialCategorySupport();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT IGNORE INTO material_categorias (nombre) VALUES (?)', [materialTipo]);
    const [result] = await connection.execute(
      `UPDATE materiales
       SET codigo = ?, nombre = ?, tipo = ?, rendimiento_m2_gal = ?, precio_unitario = ?, unidad_medida = ?
       WHERE id_material = ?`,
      [codigo, nombre, materialTipo, rendimientoMaterial, precioUnitario, unidadMedida, request.params.id]
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      return response.status(404).json({ message: 'Material no encontrado.' });
    }

    const [inventoryResult] = await connection.execute(
      'UPDATE inventario SET stock_minimo = ? WHERE id_material = ?',
      [stockMinimo, request.params.id]
    );

    if (inventoryResult.affectedRows === 0) {
      await connection.execute(
        'INSERT INTO inventario (id_material, stock_actual, stock_minimo) VALUES (?, 0, ?)',
        [request.params.id, stockMinimo]
      );
    }

    await connection.commit();
    response.json({ message: 'Material actualizado correctamente.' });
  } catch (error) {
    await connection.rollback();
    response.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({
      message: error.code === 'ER_DUP_ENTRY'
        ? 'El código del material ya está registrado.'
        : 'No fue posible actualizar el material.'
    });
  } finally {
    connection.release();
  }
});

app.delete('/api/materiales/:id', async (request, response) => {
  try {
    const [result] = await pool.execute('DELETE FROM materiales WHERE id_material = ?', [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Material no encontrado.' });
    response.json({ message: 'Material eliminado correctamente.' });
  } catch (error) {
    response.status(error.code === 'ER_ROW_IS_REFERENCED_2' ? 409 : 500).json({
      message: error.code === 'ER_ROW_IS_REFERENCED_2'
        ? 'No se puede eliminar el material porque tiene movimientos asociados.'
        : 'No fue posible eliminar el material.'
    });
  }
});

app.get('/api/proyectos', async (_request, response) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, c.nombre AS cliente_nombre
      FROM proyectos p INNER JOIN clientes c ON c.id = p.cliente_id
      ORDER BY p.id DESC
    `);
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar los proyectos.' });
  }
});

app.get('/api/proyectos/:id', async (request, response) => {
  try {
    const [rows] = await pool.execute(`
      SELECT p.*, c.nombre AS cliente_nombre
      FROM proyectos p INNER JOIN clientes c ON c.id = p.cliente_id
      WHERE p.id = ?`, [request.params.id]);
    if (!rows[0]) return response.status(404).json({ message: 'Proyecto no encontrado.' });
    response.json(rows[0]);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar el proyecto.' });
  }
});

app.post('/api/proyectos', async (request, response) => {
  const { nombre, cliente_id, estado, fecha_inicio, fecha_fin, largo, ancho, altura, tipo, presupuesto, notas } = request.body;
  if (!nombre || !cliente_id || !largo || !ancho) return response.status(400).json({ message: 'Nombre, cliente, largo y ancho son obligatorios.' });
  try {
    const [result] = await pool.execute(
      `INSERT INTO proyectos (nombre, cliente_id, estado, fecha_inicio, fecha_fin, largo, ancho, altura, tipo, presupuesto, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [nombre, cliente_id, estado || 'Pendiente', fecha_inicio || null, fecha_fin || null, largo, ancho, altura || 0, tipo || null, presupuesto || 0, notas || null]
    );
    response.status(201).json({ id: result.insertId, message: 'Proyecto guardado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible guardar el proyecto.' });
  }
});

app.put('/api/proyectos/:id', async (request, response) => {
  const { nombre, cliente_id, estado, fecha_inicio, fecha_fin, largo, ancho, altura, tipo, presupuesto, notas } = request.body;
  if (!nombre || !cliente_id || !largo || !ancho) return response.status(400).json({ message: 'Nombre, cliente, largo y ancho son obligatorios.' });
  try {
    const [result] = await pool.execute(
      `UPDATE proyectos
       SET nombre = ?, cliente_id = ?, estado = ?, fecha_inicio = ?, fecha_fin = ?, largo = ?, ancho = ?, altura = ?, tipo = ?, presupuesto = ?, notas = ?
       WHERE id = ?`,
      [nombre, cliente_id, estado || 'Pendiente', fecha_inicio || null, fecha_fin || null, largo, ancho, altura || 0, tipo || null, presupuesto || 0, notas || null, request.params.id]
    );
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Proyecto no encontrado.' });
    response.json({ message: 'Proyecto actualizado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible actualizar el proyecto.' });
  }
});

app.delete('/api/proyectos/:id', async (request, response) => {
  try {
    const [result] = await pool.execute('DELETE FROM proyectos WHERE id = ?', [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Proyecto no encontrado.' });
    response.json({ message: 'Proyecto eliminado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible eliminar el proyecto.' });
  }
});

app.get('/api/inventario', async (_request, response) => {
  try {
    await ensureInventorySupport();
    const [rows] = await pool.query(`
      SELECT
        i.id_inventario AS id,
        i.id_inventario,
        i.id_material,
        m.codigo,
        m.nombre AS material_nombre,
        m.unidad_medida AS unidad,
        i.stock_actual,
        i.stock_minimo,
        CASE
          WHEN i.stock_actual <= i.stock_minimo THEN 'Stock mínimo'
          ELSE 'Existencia normal'
        END AS estado
      FROM inventario i
      INNER JOIN materiales m ON m.id_material = i.id_material
      ORDER BY m.nombre ASC
    `);
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar el inventario.' });
  }
});

app.get('/api/inventario/movimientos', async (_request, response) => {
  try {
    await ensureInventorySupport();
    const [rows] = await pool.query(`
      SELECT
        m.id_movimiento AS id,
        m.id_movimiento,
        m.material_id,
        m.tipo,
        m.fecha,
        m.cantidad,
        m.referencia,
        m.notas,
        m.id_usuario,
        a.nombre AS material_nombre,
        u.nombre AS usuario_nombre
      FROM movimientos_inventario m
      INNER JOIN materiales a ON a.id_material = m.material_id
      LEFT JOIN usuarios u ON u.id_usuario = m.id_usuario
      ORDER BY m.fecha DESC, m.id_movimiento DESC
    `);
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar los movimientos.' });
  }
});

app.get('/api/inventario/movimientos/:id', async (request, response) => {
  try {
    await ensureInventorySupport();
    const [rows] = await pool.execute(`
      SELECT
        m.id_movimiento AS id,
        m.id_movimiento,
        m.material_id,
        m.tipo,
        m.fecha,
        m.cantidad,
        m.referencia,
        m.notas,
        m.id_usuario,
        a.nombre AS material_nombre,
        u.nombre AS usuario_nombre
      FROM movimientos_inventario m
      INNER JOIN materiales a ON a.id_material = m.material_id
      LEFT JOIN usuarios u ON u.id_usuario = m.id_usuario
      WHERE m.id_movimiento = ?`, [request.params.id]);
    if (!rows[0]) return response.status(404).json({ message: 'Movimiento no encontrado.' });
    response.json(rows[0]);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar el movimiento.' });
  }
});

app.post('/api/inventario/movimientos', async (request, response) => {
  const { material_id, material, id_usuario, usuario_id, usuario, tipo, fecha, cantidad, referencia, notas, observacion } = request.body;
  const materialId = material_id || material;
  const userId = id_usuario || usuario_id || usuario || null;
  const movementNotes = notas || observacion;
  if (!materialId || !tipo || !fecha || !cantidad) return response.status(400).json({ message: 'Material, tipo, fecha y cantidad son obligatorios.' });
  await ensureInventorySupport();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await applyInventoryDelta(connection, materialId, tipo, cantidad);
    const [result] = await connection.execute(
      'INSERT INTO movimientos_inventario (material_id, id_usuario, tipo, fecha, cantidad, referencia, notas) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [materialId, userId, tipo, fecha, cantidad, referencia || null, movementNotes || null]
    );
    await connection.commit();
    response.status(201).json({ id: result.insertId, message: 'Movimiento guardado correctamente.' });
  } catch (error) {
    await connection.rollback();
    response.status(error.statusCode || 500).json({ message: error.message || 'No fue posible guardar el movimiento.' });
  } finally {
    connection.release();
  }
});

app.put('/api/inventario/movimientos/:id', async (request, response) => {
  const { material_id, material, id_usuario, usuario_id, usuario, tipo, fecha, cantidad, referencia, notas, observacion } = request.body;
  const materialId = material_id || material;
  const userId = id_usuario || usuario_id || usuario || null;
  const movementNotes = notas || observacion;
  if (!materialId || !tipo || !fecha || !cantidad) return response.status(400).json({ message: 'Material, tipo, fecha y cantidad son obligatorios.' });
  await ensureInventorySupport();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT material_id, tipo, cantidad FROM movimientos_inventario WHERE id_movimiento = ? FOR UPDATE',
      [request.params.id]
    );
    if (!rows[0]) {
      await connection.rollback();
      return response.status(404).json({ message: 'Movimiento no encontrado.' });
    }

    await applyInventoryDelta(connection, rows[0].material_id, rows[0].tipo, rows[0].cantidad, -1);
    await applyInventoryDelta(connection, materialId, tipo, cantidad);
    const [result] = await connection.execute(
      `UPDATE movimientos_inventario
       SET material_id = ?, id_usuario = ?, tipo = ?, fecha = ?, cantidad = ?, referencia = ?, notas = ?
       WHERE id_movimiento = ?`,
      [materialId, userId, tipo, fecha, cantidad, referencia || null, movementNotes || null, request.params.id]
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      return response.status(404).json({ message: 'Movimiento no encontrado.' });
    }
    await connection.commit();
    response.json({ message: 'Movimiento actualizado correctamente.' });
  } catch (error) {
    await connection.rollback();
    response.status(error.statusCode || 500).json({ message: error.message || 'No fue posible actualizar el movimiento.' });
  } finally {
    connection.release();
  }
});

app.delete('/api/inventario/movimientos/:id', async (request, response) => {
  await ensureInventorySupport();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT material_id, tipo, cantidad FROM movimientos_inventario WHERE id_movimiento = ? FOR UPDATE',
      [request.params.id]
    );
    if (!rows[0]) {
      await connection.rollback();
      return response.status(404).json({ message: 'Movimiento no encontrado.' });
    }

    await applyInventoryDelta(connection, rows[0].material_id, rows[0].tipo, rows[0].cantidad, -1);
    const [result] = await connection.execute('DELETE FROM movimientos_inventario WHERE id_movimiento = ?', [request.params.id]);
    if (result.affectedRows === 0) {
      await connection.rollback();
      return response.status(404).json({ message: 'Movimiento no encontrado.' });
    }
    await connection.commit();
    response.json({ message: 'Movimiento eliminado correctamente.' });
  } catch (error) {
    await connection.rollback();
    response.status(error.statusCode || 500).json({ message: error.message || 'No fue posible eliminar el movimiento.' });
  } finally {
    connection.release();
  }
});

app.use((_request, response) => response.status(404).json({ message: 'Ruta no encontrada.' }));

app.listen(port, () => console.log(`API disponible en http://localhost:${port}`));

