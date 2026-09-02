const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'recubrimientos_session';
const sessionSecret = process.env.SESSION_SECRET || 'recubrimientos-dev-session-secret';
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 8);
const rememberSessionTtlMs = Number(process.env.REMEMBER_SESSION_TTL_MS || 1000 * 60 * 60 * 24 * 30);
const cookieSameSite = process.env.COOKIE_SAMESITE || 'lax';
const cookieSecure = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || 'recubrimientos',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 10
});

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function signSessionPayload(payload) {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('base64url');
}

function createSessionToken(user, remember = false) {
  const expiresAt = Date.now() + (remember ? rememberSessionTtlMs : sessionTtlMs);
  const payload = base64UrlJson({
    sub: user.id_usuario,
    nombre: user.nombre,
    email: user.email,
    rol: user.rol,
    exp: expiresAt
  });
  return `${payload}.${signSessionPayload(payload)}`;
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, item) => {
    const [rawName, ...rawValue] = item.trim().split('=');
    if (!rawName) return cookies;
    cookies[rawName] = decodeURIComponent(rawValue.join('=') || '');
    return cookies;
  }, {});
}

function verifySessionToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expectedSignature = signSessionPayload(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session.exp || Date.now() > Number(session.exp)) return null;
    return session;
  } catch (_error) {
    return null;
  }
}

function getSessionFromRequest(request) {
  const cookies = parseCookies(request.headers.cookie || '');
  return verifySessionToken(cookies[sessionCookieName]);
}

function resolveProjectUserId(request, requestUserId) {
  if (requestUserId !== undefined && requestUserId !== null && requestUserId !== '') {
    return requestUserId;
  }

  const session = getSessionFromRequest(request);
  return session ? session.sub : null;
}

function sessionCookieOptions(remember = false) {
  return {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    path: '/api',
    maxAge: remember ? rememberSessionTtlMs : sessionTtlMs
  };
}

function clearSessionCookie(response) {
  response.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: cookieSameSite,
    path: '/api'
  });
}

function requireAuth(request, response, next) {
  const session = getSessionFromRequest(request);
  if (!session) {
    return response.status(401).json({ message: 'Debe iniciar sesión para continuar.' });
  }

  request.user = session;
  next();
}

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

async function ensureProjectSupport() {
  const [existingColumns] = await pool.query(`
    SELECT COLUMN_NAME
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'proyectos'
  `);

  const columnNames = new Set(existingColumns.map((column) => column.COLUMN_NAME));

  if (!columnNames.has('id_usuario')) {
    await pool.query('ALTER TABLE proyectos ADD COLUMN id_usuario INT NULL AFTER id_cliente');
  }

  const projectColumnsToAdd = [
    ['largo', 'DECIMAL(10,2) NULL AFTER nombre_proyecto'],
    ['altura', 'DECIMAL(10,2) NULL AFTER area_m2'],
    ['tipo', 'VARCHAR(80) NULL AFTER altura'],
    ['descripcion', 'TEXT NULL AFTER tipo']
  ];

  for (const [columnName, definition] of projectColumnsToAdd) {
    if (!columnNames.has(columnName)) {
      await pool.query(`ALTER TABLE proyectos ADD COLUMN ${columnName} ${definition}`);
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS proyecto_materiales (
      id_detalle INT AUTO_INCREMENT PRIMARY KEY,
      id_proyecto INT NOT NULL,
      id_material INT NOT NULL,
      cantidad_calculada DECIMAL(10,2) NOT NULL,
      costo_subtotal DECIMAL(10,2) NOT NULL,
      FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto) ON DELETE CASCADE,
      FOREIGN KEY (id_material) REFERENCES materiales(id_material)
    )
  `);

  try {
    await pool.query(`
      ALTER TABLE proyectos
      ADD CONSTRAINT fk_proyectos_usuarios
      FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL
    `);
  } catch (_error) {
    // The foreign key may already exist.
  }
}

async function syncProjectMaterialSummary(connection, projectId) {
  const [summaryRows] = await connection.execute(`
    SELECT COALESCE(SUM(costo_subtotal), 0) AS total
    FROM proyecto_materiales
    WHERE id_proyecto = ?
  `, [projectId]);

  const total = Number(summaryRows[0]?.total ?? 0);
  await connection.execute(
    'UPDATE proyectos SET costo_estimado = ? WHERE id_proyecto = ?',
    [total, projectId]
  );

  return total;
}

async function upsertProjectMaterialRelations(connection, projectId, materiales = []) {
  const items = Array.isArray(materiales) ? materiales : [];
  await connection.execute('DELETE FROM proyecto_materiales WHERE id_proyecto = ?', [projectId]);

  for (const item of items) {
    const materialId = Number(item.id_material ?? item.id ?? item.material_id ?? 0);
    const cantidad = Number(item.cantidad ?? item.cantidad_calculada ?? item.qty ?? 0);

    if (!materialId || !Number.isFinite(cantidad) || cantidad <= 0) {
      continue;
    }

    const [materialRows] = await connection.execute(
      'SELECT precio_unitario FROM materiales WHERE id_material = ? LIMIT 1',
      [materialId]
    );

    if (!materialRows[0]) {
      continue;
    }

    const precioUnitario = Number(item.precio_unitario ?? materialRows[0].precio_unitario ?? 0);
    const subtotal = Number((cantidad * precioUnitario).toFixed(2));

    await connection.execute(
      `INSERT INTO proyecto_materiales (id_proyecto, id_material, cantidad_calculada, costo_subtotal)
       VALUES (?, ?, ?, ?)`,
      [projectId, materialId, cantidad, subtotal]
    );
  }

  await syncProjectMaterialSummary(connection, projectId);
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
  allowedHeaders: ['Content-Type'],
  credentials: true
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
  const { usuario, contrasena, recordar } = request.body;
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
    const rememberSession = ['1', 'true', 'on', true, 1].includes(recordar);
    response.cookie(sessionCookieName, createSessionToken(user, rememberSession), sessionCookieOptions(rememberSession));
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

app.get('/api/auth/session', (request, response) => {
  const session = getSessionFromRequest(request);
  if (!session) return response.status(401).json({ authenticated: false, message: 'Sesión no válida o expirada.' });

  response.json({
    authenticated: true,
    user: {
      id: session.sub,
      id_usuario: session.sub,
      nombre: session.nombre,
      usuario: session.email,
      email: session.email,
      rol: session.rol
    }
  });
});

app.get('/api/auth/me', async (request, response) => {
  const session = getSessionFromRequest(request);
  if (!session) return response.status(401).json({ message: 'Debe iniciar sesión para continuar.' });

  try {
    const [rows] = await pool.execute(
      `SELECT id_usuario, nombre, email, rol, estado
       FROM usuarios
       WHERE id_usuario = ?
       LIMIT 1`,
      [session.sub]
    );

    const user = rows[0];
    if (!user) return response.status(404).json({ message: 'Usuario no encontrado.' });

    response.json({
      id: user.id_usuario,
      id_usuario: user.id_usuario,
      nombre: user.nombre,
      usuario: user.email,
      email: user.email,
      rol: user.rol,
      estado: user.estado
    });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible obtener el usuario actual.' });
  }
});

app.post('/api/auth/logout', (_request, response) => {
  clearSessionCookie(response);
  response.json({ message: 'Sesión cerrada correctamente.' });
});

app.use('/api', requireAuth);

async function crearUsuario(request, response) {
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
}

app.post('/api/usuarios', crearUsuario);
app.post('/api/auth/usuarios', crearUsuario);

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

app.get('/api/usuarios/:id', async (request, response) => {
  try {
    const [rows] = await pool.execute(`
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
      WHERE id_usuario = ?
    `, [request.params.id]);

    if (!rows[0]) return response.status(404).json({ message: 'Usuario no encontrado.' });
    response.json(rows[0]);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar el usuario.' });
  }
});

app.put('/api/usuarios/:id', async (request, response) => {
  const { nombre, email, usuario, rol = 'Operador', estado = 'Activo', contrasena } = request.body;
  const userEmail = email || usuario;

  if (!nombre || !userEmail) {
    return response.status(400).json({ message: 'Nombre y correo son obligatorios.' });
  }

  try {
    const updateValues = [nombre, userEmail, rol, estado, request.params.id];
    let query = 'UPDATE usuarios SET nombre = ?, email = ?, rol = ?, estado = ?';

    if (contrasena) {
      const hash = await bcrypt.hash(contrasena, 12);
      query += ', password_hash = ?';
      updateValues.splice(4, 0, hash);
    }

    query += ' WHERE id_usuario = ?';

    const [result] = await pool.execute(query, updateValues);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Usuario no encontrado.' });

    if (request.user && Number(request.user.sub) === Number(request.params.id)) {
      const refreshedUser = {
        id_usuario: Number(request.params.id),
        nombre,
        email: userEmail,
        rol,
        estado
      };
      response.cookie(
        sessionCookieName,
        createSessionToken(refreshedUser),
        sessionCookieOptions(false)
      );
    }

    response.json({ message: 'Usuario actualizado correctamente.' });
  } catch (error) {
    response.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({
      message: error.code === 'ER_DUP_ENTRY'
        ? 'El correo electrónico ya está registrado.'
        : 'No fue posible actualizar el usuario.'
    });
  }
});

app.delete('/api/usuarios/:id', async (request, response) => {
  try {
    const [result] = await pool.execute('DELETE FROM usuarios WHERE id_usuario = ?', [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Usuario no encontrado.' });
    response.json({ message: 'Usuario eliminado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible eliminar el usuario.' });
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
    await ensureProjectSupport();
    const [rows] = await pool.query(`
      SELECT
        p.id_proyecto AS id,
        p.id_proyecto,
        p.id_cliente,
        COALESCE(p.id_usuario, 0) AS id_usuario,
        p.nombre_proyecto AS nombre,
        p.nombre_proyecto,
        COALESCE(p.largo, p.area_m2) AS largo,
        p.area_m2,
        p.altura,
        p.tipo,
        p.descripcion,
        p.estado,
        p.costo_estimado AS presupuesto,
        p.costo_estimado,
        p.fecha_inicio,
        p.fecha_creacion,
        c.nombre AS cliente_nombre
      FROM proyectos p
      LEFT JOIN clientes c ON c.id_cliente = p.id_cliente
      ORDER BY p.id_proyecto DESC
    `);
    response.json(rows);
  } catch (error) {
    console.error('Error al consultar proyectos:', error);
    response.status(500).json({ message: 'No fue posible consultar los proyectos.' });
  }
});

app.get('/api/proyectos/:id', async (request, response) => {
  try {
    await ensureProjectSupport();
    const [rows] = await pool.execute(`
      SELECT
        p.id_proyecto AS id,
        p.id_proyecto,
        p.id_cliente,
        COALESCE(p.id_usuario, 0) AS id_usuario,
        p.nombre_proyecto AS nombre,
        p.nombre_proyecto,
        COALESCE(p.largo, p.area_m2) AS largo,
        p.area_m2,
        p.altura,
        p.tipo,
        p.descripcion,
        p.estado,
        p.costo_estimado AS presupuesto,
        p.costo_estimado,
        p.fecha_inicio,
        p.fecha_creacion,
        c.nombre AS cliente_nombre
      FROM proyectos p
      LEFT JOIN clientes c ON c.id_cliente = p.id_cliente
      WHERE p.id_proyecto = ?`, [request.params.id]);
    if (!rows[0]) return response.status(404).json({ message: 'Proyecto no encontrado.' });

    const [materialRows] = await pool.execute(`
      SELECT pm.id_detalle, pm.id_material, m.nombre AS material_nombre, pm.cantidad_calculada, pm.costo_subtotal, m.precio_unitario
      FROM proyecto_materiales pm
      JOIN materiales m ON m.id_material = pm.id_material
      WHERE pm.id_proyecto = ?
      ORDER BY pm.id_detalle ASC
    `, [request.params.id]);

    const project = rows[0];
    project.materiales = materialRows;
    response.json(project);
  } catch (error) {
    console.error('Error al consultar proyecto por id:', error);
    response.status(500).json({ message: 'No fue posible consultar el proyecto.' });
  }
});

app.get('/api/proyectos/:id/materiales', async (request, response) => {
  try {
    await ensureProjectSupport();
    const [rows] = await pool.execute(`
      SELECT pm.id_detalle, pm.id_material, m.nombre AS material_nombre, pm.cantidad_calculada, pm.costo_subtotal, m.precio_unitario
      FROM proyecto_materiales pm
      JOIN materiales m ON m.id_material = pm.id_material
      WHERE pm.id_proyecto = ?
      ORDER BY pm.id_detalle ASC
    `, [request.params.id]);

    response.json(rows);
  } catch (error) {
    response.status(500).json({ message: 'No fue posible consultar los materiales del proyecto.' });
  }
});

app.post('/api/proyectos/:id/materiales', async (request, response) => {
  try {
    await ensureProjectSupport();
    const projectId = Number(request.params.id);
    const { id_material, cantidad, precio_unitario } = request.body || {};
    const materialId = Number(id_material ?? 0);
    const quantity = Number(cantidad ?? 0);

    if (!projectId || !materialId || !Number.isFinite(quantity) || quantity <= 0) {
      return response.status(400).json({ message: 'Material y cantidad válidos son obligatorios.' });
    }

    const [materialRows] = await pool.execute(
      'SELECT precio_unitario FROM materiales WHERE id_material = ? LIMIT 1',
      [materialId]
    );

    if (!materialRows[0]) {
      return response.status(404).json({ message: 'Material no encontrado.' });
    }

    const finalUnitPrice = Number(precio_unitario ?? materialRows[0].precio_unitario ?? 0);
    const subtotal = Number((quantity * finalUnitPrice).toFixed(2));

    await pool.execute(
      `INSERT INTO proyecto_materiales (id_proyecto, id_material, cantidad_calculada, costo_subtotal)
       VALUES (?, ?, ?, ?)`,
      [projectId, materialId, quantity, subtotal]
    );

    await syncProjectMaterialSummary(pool, projectId);
    response.status(201).json({ message: 'Material agregado al proyecto correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible guardar el material del proyecto.' });
  }
});

app.delete('/api/proyectos/:id/materiales/:detalleId', async (request, response) => {
  try {
    await ensureProjectSupport();
    const [result] = await pool.execute(
      'DELETE FROM proyecto_materiales WHERE id_proyecto = ? AND id_detalle = ?',
      [request.params.id, request.params.detalleId]
    );

    if (result.affectedRows === 0) {
      return response.status(404).json({ message: 'Material del proyecto no encontrado.' });
    }

    await syncProjectMaterialSummary(pool, Number(request.params.id));
    response.json({ message: 'Material del proyecto eliminado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible eliminar el material del proyecto.' });
  }
});

function normalizeProjectDate(value) {
  if (value === null || value === undefined || value === '') return null;

  const rawValue = String(value).trim();
  if (!rawValue) return null;

  const isoDateMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateMatch) {
    return rawValue;
  }

  const europeanDateMatch = rawValue.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (europeanDateMatch) {
    const [, day, month, year] = europeanDateMatch;
    return `${year}-${month}-${day}`;
  }

  const isoDateWithTimeMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})T.*$/);
  if (isoDateWithTimeMatch) {
    return `${isoDateWithTimeMatch[1]}-${isoDateWithTimeMatch[2]}-${isoDateWithTimeMatch[3]}`;
  }

  const parsedDate = new Date(rawValue);
  if (!Number.isNaN(parsedDate.getTime())) {
    const localDate = new Date(parsedDate.getTime() - (parsedDate.getTimezoneOffset() * 60000));
    return localDate.toISOString().slice(0, 10);
  }

  return rawValue;
}

app.post('/api/proyectos', async (request, response) => {
  await ensureProjectSupport();
  const { nombre, nombre_proyecto, id_cliente, cliente_id, id_usuario, usuario_id, estado, fecha_inicio, fechaInicio, largo, area_m2, altura, tipo, presupuesto, costo_estimado, descripcion, materiales } = request.body;
  const finalNombre = nombre || nombre_proyecto;
  const finalClienteId = id_cliente || cliente_id;
  const finalUsuarioId = resolveProjectUserId(request, id_usuario || usuario_id);
  const finalFechaInicio = normalizeProjectDate(fecha_inicio ?? fechaInicio ?? null);
  const finalLargo = Number(largo ?? 0);
  const finalPresupuesto = presupuesto ?? costo_estimado ?? 0;
  const finalArea = area_m2 ?? (finalLargo && altura ? Number(finalLargo) * Number(altura) : 0);
  const finalDescripcion = descripcion ?? null;
  const finalEstado = 'Pendiente';

  if (!finalNombre || !finalClienteId || !finalUsuarioId || !finalLargo || !finalArea) {
    return response.status(400).json({ message: 'Nombre, cliente, usuario, largo y área son obligatorios.' });
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO proyectos (id_cliente, id_usuario, nombre_proyecto, largo, area_m2, altura, tipo, estado, costo_estimado, fecha_inicio, descripcion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [finalClienteId, finalUsuarioId, finalNombre, finalLargo || null, finalArea, altura ?? null, tipo || null, finalEstado, finalPresupuesto || 0, finalFechaInicio || null, finalDescripcion || null]
    );

    const projectId = Number(result.insertId);
    if (Array.isArray(materiales) && materiales.length) {
      await upsertProjectMaterialRelations(pool, projectId, materiales);
    }

    response.status(201).json({ id: projectId, id_proyecto: projectId, message: 'Proyecto guardado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible guardar el proyecto.' });
  }
});

app.put('/api/proyectos/:id', async (request, response) => {
  await ensureProjectSupport();

  try {
    const [existingRows] = await pool.execute(`
      SELECT *
      FROM proyectos
      WHERE id_proyecto = ?
    `, [request.params.id]);

    if (!existingRows[0]) {
      return response.status(404).json({ message: 'Proyecto no encontrado.' });
    }

    const currentProject = existingRows[0];
    const incoming = request.body || {};
    const merged = {
      ...currentProject,
      ...incoming,
      nombre_proyecto: incoming.nombre_proyecto ?? incoming.nombre ?? currentProject.nombre_proyecto,
      id_cliente: incoming.id_cliente ?? incoming.cliente_id ?? currentProject.id_cliente,
      id_usuario: incoming.id_usuario ?? incoming.usuario_id ?? currentProject.id_usuario,
      fecha_inicio: incoming.fecha_inicio ?? incoming.fechaInicio ?? currentProject.fecha_inicio,
      largo: incoming.largo ?? currentProject.largo,
      area_m2: incoming.area_m2 ?? currentProject.area_m2,
      altura: incoming.altura ?? currentProject.altura,
      tipo: incoming.tipo ?? currentProject.tipo,
      costo_estimado: incoming.costo_estimado ?? incoming.presupuesto ?? currentProject.costo_estimado,
      descripcion: incoming.descripcion ?? currentProject.descripcion,
      estado: incoming.estado ?? currentProject.estado ?? 'Pendiente'
    };

    const finalNombre = merged.nombre_proyecto || merged.nombre;
    const finalClienteId = merged.id_cliente;
    const finalUsuarioId = resolveProjectUserId(request, merged.id_usuario);
    const finalFechaInicio = normalizeProjectDate(merged.fecha_inicio ?? null);
    const finalLargo = Number(merged.largo ?? 0);
    const finalPresupuesto = merged.costo_estimado ?? 0;
    const finalArea = merged.area_m2 ?? (finalLargo && merged.altura ? Number(finalLargo) * Number(merged.altura) : 0);
    const finalDescripcion = merged.descripcion ?? null;
    const finalEstado = merged.estado || 'Pendiente';

    if (!finalNombre || !finalClienteId || !finalUsuarioId || !finalLargo || !finalArea) {
      return response.status(400).json({ message: 'Nombre, cliente, usuario, largo y área son obligatorios.' });
    }

    const [result] = await pool.execute(
      `UPDATE proyectos
       SET id_cliente = ?, id_usuario = ?, nombre_proyecto = ?, largo = ?, area_m2 = ?, altura = ?, tipo = ?, estado = ?, costo_estimado = ?, fecha_inicio = ?, descripcion = ?
       WHERE id_proyecto = ?`,
      [finalClienteId, finalUsuarioId, finalNombre, finalLargo || null, finalArea, merged.altura ?? null, merged.tipo || null, finalEstado, finalPresupuesto || 0, finalFechaInicio || null, finalDescripcion || null, request.params.id]
    );

    if (result.affectedRows === 0) return response.status(404).json({ message: 'Proyecto no encontrado.' });

    if (Array.isArray(request.body.materiales) && request.body.materiales.length) {
      await upsertProjectMaterialRelations(pool, Number(request.params.id), request.body.materiales);
    }

    response.json({ message: 'Proyecto actualizado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible actualizar el proyecto.' });
  }
});

app.delete('/api/proyectos/:id', async (request, response) => {
  try {
    const [result] = await pool.execute('DELETE FROM proyectos WHERE id_proyecto = ?', [request.params.id]);
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

