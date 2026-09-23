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
const materialImageMaxMb = Number(process.env.MATERIAL_IMAGE_MAX_MB || 5);
const materialImageMaxChars = Math.ceil(materialImageMaxMb * 1024 * 1024 * 4 / 3) + 100;
const jsonBodyLimitMb = Math.ceil(materialImageMaxMb * 4 / 3) + 1;
const cookieSameSite = process.env.COOKIE_SAMESITE || (process.env.NODE_ENV === 'production' ? 'none' : 'lax');
const cookieSecure = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';
const corsOrigins = (process.env.FRONTEND_URL || 'http://127.0.0.1:5500,http://localhost:5500')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveMaterialCategoryId(connection, categoryInput, categoryNameFallback = null) {
  const rawValue = categoryInput ?? categoryNameFallback ?? null;
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }

  const normalizedId = Number(rawValue);
  if (Number.isInteger(normalizedId) && normalizedId > 0) {
    const [existingRows] = await connection.execute(
      'SELECT id_categoria FROM material_categorias WHERE id_categoria = ? LIMIT 1',
      [normalizedId]
    );
    if (existingRows[0]) {
      return normalizedId;
    }
  }

  const categoryName = String(rawValue).trim();
  if (!categoryName) {
    return null;
  }

  const [rows] = await connection.execute(
    'SELECT id_categoria FROM material_categorias WHERE nombre = ? LIMIT 1',
    [categoryName]
  );
  if (rows[0]) {
    return rows[0].id_categoria;
  }

  const [insertResult] = await connection.execute(
    'INSERT INTO material_categorias (nombre, prefijo_codigo) VALUES (?, ?)',
    [categoryName, categoryName.slice(0, 3).toUpperCase()]
  );
  return insertResult.insertId;
}

async function generateMaterialCode(connection, categoryInput, categoryNameFallback = null) {
  const rawValue = categoryInput ?? categoryNameFallback ?? null;
  let categoryRecord = null;

  if (rawValue !== null && rawValue !== undefined && rawValue !== '') {
    const normalizedId = Number(rawValue);
    if (Number.isInteger(normalizedId) && normalizedId > 0) {
      const [rows] = await connection.execute(
        'SELECT id_categoria, nombre, prefijo_codigo FROM material_categorias WHERE id_categoria = ? LIMIT 1',
        [normalizedId]
      );
      if (rows[0]) categoryRecord = rows[0];
    }

    if (!categoryRecord) {
      const categoryName = String(rawValue).trim();
      if (categoryName) {
        const [rows] = await connection.execute(
          'SELECT id_categoria, nombre, prefijo_codigo FROM material_categorias WHERE nombre = ? LIMIT 1',
          [categoryName]
        );
        if (rows[0]) categoryRecord = rows[0];
      }
    }
  }

  const basePrefix = (categoryRecord?.prefijo_codigo || categoryRecord?.nombre || categoryNameFallback || 'MAT')
    .toString()
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 10)
    .toUpperCase() || 'MAT';

  const normalizedPrefix = basePrefix || 'MAT';
  const safePrefix = escapeRegExp(normalizedPrefix);
  const [rows] = await connection.execute(
    'SELECT codigo FROM materiales WHERE codigo LIKE ? ORDER BY codigo DESC',
    [`${normalizedPrefix}-%`]
  );

  let maxNumber = 0;
  for (const row of rows) {
    const match = String(row.codigo || '').match(new RegExp(`^${safePrefix}-(\\d+)$`, 'i'));
    if (match) {
      const numericValue = Number(match[1] || 0);
      if (numericValue > maxNumber) maxNumber = numericValue;
    }
  }

  return `${normalizedPrefix}-${String(maxNumber + 1).padStart(3, '0')}`;
}

function nextMaterialCodeFrom(code) {
  const match = String(code || '').match(/^(.*-)(\d+)$/);
  if (!match) return `${code}-1`;
  return `${match[1]}${String(Number(match[2]) + 1).padStart(match[2].length, '0')}`;
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

function requireAdministrator(request, response, next) {
  const isArchiveOperation = request.method === 'PATCH' && /\/(archivar|desarchivar)$/.test(request.path);
  if (isArchiveOperation) {
    return next();
  }

  if (request.user?.rol !== 'Administrador') {
    return response.status(403).json({ message: 'No tiene permisos para administrar usuarios.' });
  }

  next();
}

function requireAdministratorForDelete(request, response, next) {
  if (request.user?.rol !== 'Administrador') {
    return response.status(403).json({ message: 'Los operadores no pueden eliminar registros definitivamente. Deben archivarlos.' });
  }

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

async function ensureUserDeleteAuditTrigger() {
  await pool.query('DROP TRIGGER IF EXISTS trg_aud_usuarios_delete');
  await pool.query(`
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
    END
  `);

}

function isValidMaterialImage(image) {
  return !image || (
    typeof image === 'string' &&
    image.length <= materialImageMaxChars &&
    /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image)
  );
}

async function resolveValidUserId(connection, sessionUserId, requestedUserId) {
  const candidates = [sessionUserId, requestedUserId]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  for (const candidate of candidates) {
    const [rows] = await connection.execute(
      'SELECT id_usuario FROM usuarios WHERE id_usuario = ? LIMIT 1',
      [candidate]
    );
    if (rows[0]) return rows[0].id_usuario;
  }

  return null;
}

async function ensureMaterialCategorySupport() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS material_categorias (
      id_categoria INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(60) NOT NULL UNIQUE,
      prefijo_codigo VARCHAR(10) NULL,
      fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    await pool.query('ALTER TABLE material_categorias ADD COLUMN prefijo_codigo VARCHAR(10) NULL');
  } catch (_error) {
    // Existing installations may already include this column.
  }

  let salePriceAdded = false;
  try {
    await pool.query('ALTER TABLE materiales ADD COLUMN precio_venta DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER precio_unitario');
    salePriceAdded = true;
  } catch (_error) {
    // Existing installations may already include the sale price column.
  }

  for (const definition of [
    "modo_uso ENUM('Consumible', 'Reutilizable') NOT NULL DEFAULT 'Consumible'",
    'usos_estimados INT NOT NULL DEFAULT 1',
    'precio_uso DECIMAL(10,2) NOT NULL DEFAULT 0.00'
  ]) {
    try {
      await pool.query(`ALTER TABLE materiales ADD COLUMN ${definition}`);
    } catch (_error) {
      // Existing installations may already include this column.
    }
  }

  if (salePriceAdded) {
    try {
      await pool.query('UPDATE materiales SET precio_venta = precio_unitario WHERE precio_venta = 0 AND precio_unitario > 0');
    } catch (_error) {
      // Existing data remains usable if the migration user cannot update rows.
    }
  }

  try {
    await pool.query('ALTER TABLE materiales MODIFY tipo VARCHAR(60) NOT NULL');
  } catch (_error) {
    // If the column is already compatible or the DB user cannot alter it, the API can still use existing categories.
  }

  try {
    await pool.query('ALTER TABLE materiales ADD COLUMN descripcion TEXT NULL');
  } catch (_error) {
    // Existing installations may already have the column.
  }

  try {
    await pool.query('ALTER TABLE materiales ADD COLUMN imagen LONGTEXT NULL');
  } catch (_error) {
    // Existing installations may already have the column.
  }

  try {
    await pool.query('ALTER TABLE materiales ADD COLUMN color VARCHAR(60) NULL AFTER nombre');
  } catch (_error) {
    // Existing installations may already have the column.
  }

  try {
    await pool.query('ALTER TABLE materiales ADD COLUMN marca VARCHAR(80) NULL AFTER nombre');
  } catch (_error) {
    // Existing installations may already have the column.
  }

  try {
    await pool.query('ALTER TABLE materiales ADD COLUMN codigo_color VARCHAR(7) NULL AFTER color');
  } catch (_error) {
    // Existing installations may already have the column.
  }

  try {
    await pool.query("ALTER TABLE materiales ADD COLUMN estado ENUM('Activo', 'Archivado') NOT NULL DEFAULT 'Activo'");
  } catch (_error) {
    // Existing installations may already have this column.
  }
}

async function ensureInventorySupport() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventario_lotes (
      id_lote INT AUTO_INCREMENT PRIMARY KEY,
      id_material INT NOT NULL,
      cantidad_inicial DECIMAL(10,2) NOT NULL,
      cantidad_disponible DECIMAL(10,2) NOT NULL,
      costo_unitario DECIMAL(10,2) NOT NULL DEFAULT 0,
      fecha_entrada DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_material) REFERENCES materiales(id_material) ON DELETE CASCADE
    )
  `);

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
    await pool.query('ALTER TABLE movimientos_inventario ADD COLUMN costo_unitario DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER cantidad');
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

  try {
    await pool.query(`
      INSERT INTO inventario_lotes (id_material, cantidad_inicial, cantidad_disponible, costo_unitario)
      SELECT i.id_material, i.stock_actual, i.stock_actual, COALESCE(m.precio_unitario, 0)
      FROM inventario i
      INNER JOIN materiales m ON m.id_material = i.id_material
      LEFT JOIN inventario_lotes l ON l.id_material = i.id_material
      WHERE i.stock_actual > 0 AND l.id_lote IS NULL
    `);
  } catch (_error) {
    // La migración de lotes se reintentará en la siguiente operación si aún no está disponible.
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
    ['id_mano_obra', 'INT NULL AFTER tipo'],
    ['mano_obra_precio_m2', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER id_mano_obra'],
    ['descripcion', 'TEXT NULL AFTER tipo'],
    ['costo_materiales', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER estado_archivado'],
    ['costo_herramientas', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER costo_materiales'],
    ['precio_herramientas', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER costo_herramientas'],
    ['costo_mano_obra', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER costo_materiales'],
    ['precio_mano_obra', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER costo_mano_obra'],
    ['costo_total', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER precio_mano_obra'],
    ['precio_cotizacion', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER costo_total']
  ];

  for (const [columnName, definition] of projectColumnsToAdd) {
    if (!columnNames.has(columnName)) {
      await pool.query(`ALTER TABLE proyectos ADD COLUMN ${columnName} ${definition}`);
    }
  }

  try {
    await pool.query(`
      ALTER TABLE proyectos
      ADD CONSTRAINT fk_proyectos_mano_obra
      FOREIGN KEY (id_mano_obra) REFERENCES materiales(id_material) ON DELETE SET NULL
    `);
  } catch (_error) {
    // The foreign key may already exist.
  }

  try {
    await pool.query(`
      UPDATE proyectos
      SET costo_materiales = COALESCE(costo_estimado, 0),
          costo_total = COALESCE(costo_estimado, 0),
          precio_cotizacion = COALESCE(costo_estimado, 0)
      WHERE costo_materiales = 0 AND costo_total = 0 AND precio_cotizacion = 0
        AND COALESCE(costo_estimado, 0) > 0
    `);
  } catch (_error) {
    // Existing data can still be used if the migration user cannot update rows.
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS proyecto_materiales (
      id_detalle INT AUTO_INCREMENT PRIMARY KEY,
      id_usuario INT NULL,
      id_proyecto INT NOT NULL,
      id_material INT NOT NULL,
      cantidad_calculada DECIMAL(10,2) NOT NULL,
      costo_subtotal DECIMAL(10,2) NOT NULL,
      precio_subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto) ON DELETE CASCADE,
      FOREIGN KEY (id_material) REFERENCES materiales(id_material)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS proyecto_herramientas (
      id_asignacion INT AUTO_INCREMENT PRIMARY KEY,
      id_proyecto INT NOT NULL,
      id_material INT NOT NULL,
      cantidad INT NOT NULL,
      devueltas INT NOT NULL DEFAULT 0,
      dadas_baja INT NOT NULL DEFAULT 0,
      costo_uso DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      precio_uso DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      costo_baja DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      precio_baja DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      fecha_asignacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (id_proyecto) REFERENCES proyectos(id_proyecto) ON DELETE CASCADE,
      FOREIGN KEY (id_material) REFERENCES materiales(id_material)
    )
  `);

  try {
    await pool.query('ALTER TABLE proyecto_materiales ADD COLUMN detalle_peps LONGTEXT NULL AFTER costo_subtotal');
  } catch (_error) {
    // Existing installations may already have this column.
  }

  try {
    await pool.query('ALTER TABLE proyecto_materiales ADD COLUMN precio_subtotal DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER costo_subtotal');
  } catch (_error) {
    // Existing installations may already include the sale subtotal column.
  }

  try {
    await pool.query('UPDATE proyecto_materiales SET precio_subtotal = costo_subtotal WHERE precio_subtotal = 0 AND costo_subtotal > 0');
  } catch (_error) {
    // Existing data remains usable if the migration user cannot update rows.
  }

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

async function ensureArchiveSupport() {
  const columns = [
    ['clientes', 'estado_archivado', "ENUM('Activo', 'Archivado') NOT NULL DEFAULT 'Activo'"],
    ['proyectos', 'estado_archivado', "ENUM('Activo', 'Archivado') NOT NULL DEFAULT 'Activo'"],
    ['usuarios', 'estado_archivado', "ENUM('Activo', 'Archivado') NOT NULL DEFAULT 'Activo'"]
  ];

  for (const [table, column, definition] of columns) {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (_error) {
      // Existing installations already have the archive column.
    }
  }
}

async function syncProjectMaterialSummary(connection, projectId) {
  const [summaryRows] = await connection.execute(`
    SELECT COALESCE(SUM(costo_subtotal), 0) AS costo_total,
           COALESCE(SUM(CASE WHEN precio_subtotal > 0 THEN precio_subtotal ELSE costo_subtotal END), 0) AS venta_total
    FROM proyecto_materiales
    WHERE id_proyecto = ?
  `, [projectId]);

  const total = Number(summaryRows[0]?.costo_total ?? 0);
  const venta = Number(summaryRows[0]?.venta_total ?? 0);
  const [toolRows] = await connection.execute(`
    SELECT COALESCE(SUM(costo_uso + costo_baja), 0) AS costo,
           COALESCE(SUM(precio_uso + precio_baja), 0) AS precio
    FROM proyecto_herramientas WHERE id_proyecto = ?
  `, [projectId]);
  const costoHerramientas = Number(toolRows[0]?.costo ?? 0);
  const precioHerramientas = Number(toolRows[0]?.precio ?? 0);
  await connection.execute(
    `UPDATE proyectos
     SET costo_materiales = ?,
         costo_herramientas = ?,
         precio_herramientas = ?,
         costo_total = ? + ? + costo_mano_obra,
         precio_cotizacion = ? + ? + precio_mano_obra,
         costo_estimado = ? + ? + precio_mano_obra
     WHERE id_proyecto = ?`,
    [total, costoHerramientas, precioHerramientas, total, costoHerramientas, venta, precioHerramientas, venta, precioHerramientas, projectId]
  );

  return total;
}

async function upsertProjectMaterialRelations(connection, projectId, materiales = [], userId = null) {
  const items = Array.isArray(materiales) ? materiales : [];
  const [projectRows] = await connection.execute('SELECT nombre_proyecto FROM proyectos WHERE id_proyecto = ? LIMIT 1', [projectId]);
  const projectName = projectRows[0]?.nombre_proyecto || `#${projectId}`;
  const [previousRows] = await connection.execute(
    'SELECT id_material, cantidad_calculada FROM proyecto_materiales WHERE id_proyecto = ?',
    [projectId]
  );
  await connection.execute('DELETE FROM proyecto_materiales WHERE id_proyecto = ?', [projectId]);

  for (const previous of previousRows) {
    await applyInventoryDelta(connection, previous.id_material, 'Entrada', previous.cantidad_calculada);
    await connection.execute(
      'INSERT INTO movimientos_inventario (material_id, id_usuario, tipo, fecha, cantidad, referencia, notas) VALUES (?, ?, ?, CURDATE(), ?, ?, ?)',
      [previous.id_material, userId, 'Entrada', previous.cantidad_calculada, `Reversión proyecto: ${projectName}`, 'Material retirado de la asignación del proyecto']
    );
  }

  for (const item of items) {
    const materialId = Number(item.id_material ?? item.id ?? item.material_id ?? 0);
    const cantidad = Number(item.cantidad ?? item.cantidad_calculada ?? item.qty ?? 0);

    if (!materialId || !Number.isFinite(cantidad) || cantidad <= 0) {
      continue;
    }

    const [materialRows] = await connection.execute(
      "SELECT precio_unitario, precio_venta FROM materiales WHERE id_material = ? AND modo_uso = 'Consumible' LIMIT 1",
      [materialId]
    );

    if (!materialRows[0]) {
      continue;
    }

    const salida = await applyInventoryDelta(connection, materialId, 'Salida', cantidad);
    const subtotal = Number(salida.costo.toFixed(2));
    await connection.execute(
      'INSERT INTO movimientos_inventario (material_id, id_usuario, tipo, fecha, cantidad, referencia, notas) VALUES (?, ?, ?, CURDATE(), ?, ?, ?)',
      [materialId, userId, 'Salida', cantidad, `Proyecto: ${projectName}`, 'Material asignado al proyecto']
    );

    await connection.execute(
      `INSERT INTO proyecto_materiales (id_proyecto, id_material, cantidad_calculada, costo_subtotal, precio_subtotal, detalle_peps)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [projectId, materialId, cantidad, subtotal, Number((cantidad * Number(materialRows[0].precio_venta ?? materialRows[0].precio_unitario ?? 0)).toFixed(2)), JSON.stringify(salida.detalle)]
    );
  }

  await syncProjectMaterialSummary(connection, projectId);
}

async function assignProjectTools(connection, projectId, tools = []) {
  if (!Array.isArray(tools)) throw Object.assign(new Error('La lista de herramientas no es válida.'), { statusCode: 400 });
  for (const tool of tools) {
    const materialId = Number(tool.id_material);
    const quantity = Number(tool.cantidad);
    if (!Number.isInteger(materialId) || materialId < 1 || !Number.isInteger(quantity) || quantity < 1) {
      throw Object.assign(new Error('Seleccione una herramienta y una cantidad válida.'), { statusCode: 400 });
    }
    const [rows] = await connection.execute(`
      SELECT m.precio_unitario, m.precio_uso, m.usos_estimados, i.stock_actual
      FROM materiales m JOIN inventario i ON i.id_material = m.id_material
      WHERE m.id_material = ? AND m.modo_uso = 'Reutilizable' AND m.estado = 'Activo'
      FOR UPDATE
    `, [materialId]);
    if (!rows[0]) throw Object.assign(new Error('La herramienta seleccionada no está disponible.'), { statusCode: 400 });
    const [loanRows] = await connection.execute(`
      SELECT COALESCE(SUM(cantidad - devueltas - dadas_baja), 0) AS prestadas
      FROM proyecto_herramientas WHERE id_material = ?
    `, [materialId]);
    const available = Number(rows[0].stock_actual) - Number(loanRows[0]?.prestadas ?? 0);
    if (quantity > available) throw Object.assign(new Error(`Solo hay ${available} unidades disponibles de la herramienta.`), { statusCode: 409 });
    const cost = Number((quantity * Number(rows[0].precio_unitario) / Number(rows[0].usos_estimados || 1)).toFixed(2));
    const price = Number((quantity * Number(rows[0].precio_uso || 0)).toFixed(2));
    await connection.execute(`
      INSERT INTO proyecto_herramientas (id_proyecto, id_material, cantidad, costo_uso, precio_uso)
      VALUES (?, ?, ?, ?, ?)
    `, [projectId, materialId, quantity, cost, price]);
  }
  await syncProjectMaterialSummary(connection, projectId);
}

async function applyInventoryDelta(connection, materialId, tipo, cantidad, direction = 1, unitCost = null, allowLoanedLoss = false) {
  const normalizedType = String(tipo || '').toLowerCase();
  const movementQuantity = Number(cantidad);
  if (!materialId || !Number.isFinite(movementQuantity) || movementQuantity <= 0) {
    const error = new Error('Material y cantidad válidos son obligatorios.');
    error.statusCode = 400;
    throw error;
  }

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

  const [materialRows] = await connection.execute(
    'SELECT precio_unitario FROM materiales WHERE id_material = ? LIMIT 1',
    [materialId]
  );
  const defaultCost = Number(unitCost ?? materialRows[0]?.precio_unitario ?? 0);

  const [lotRows] = await connection.execute(
    'SELECT id_lote, cantidad_disponible, costo_unitario FROM inventario_lotes WHERE id_material = ? AND cantidad_disponible > 0 ORDER BY id_lote ASC FOR UPDATE',
    [materialId]
  );
  const currentStock = Number(inventoryRows[0]?.stock_actual || 0);
  if (!lotRows.length && currentStock > 0) {
    await connection.execute(
      'INSERT INTO inventario_lotes (id_material, cantidad_inicial, cantidad_disponible, costo_unitario) VALUES (?, ?, ?, ?)',
      [materialId, currentStock, currentStock, defaultCost]
    );
  }

  const isSalida = normalizedType === 'salida';
  const effectiveSalida = isSalida === (direction === 1);
  if (effectiveSalida) {
    if (!allowLoanedLoss) {
      const [loanRows] = await connection.execute(`
        SELECT COALESCE(SUM(cantidad - devueltas - dadas_baja), 0) AS prestadas
        FROM proyecto_herramientas WHERE id_material = ?
      `, [materialId]);
      if (movementQuantity > currentStock - Number(loanRows[0]?.prestadas || 0)) {
        throw Object.assign(new Error('No hay unidades libres suficientes; algunas están prestadas a proyectos.'), { statusCode: 409 });
      }
    }
    const availableLots = lotRows.length ? lotRows : (await connection.execute(
      'SELECT id_lote, cantidad_disponible, costo_unitario FROM inventario_lotes WHERE id_material = ? AND cantidad_disponible > 0 ORDER BY id_lote ASC FOR UPDATE',
      [materialId]
    ))[0];
    let remaining = movementQuantity;
    let cost = 0;
    const detalle = [];
    for (const lot of availableLots) {
      if (remaining <= 0) break;
      const consumed = Math.min(remaining, Number(lot.cantidad_disponible));
      await connection.execute(
        'UPDATE inventario_lotes SET cantidad_disponible = cantidad_disponible - ? WHERE id_lote = ?',
        [consumed, lot.id_lote]
      );
      remaining -= consumed;
      cost += consumed * Number(lot.costo_unitario);
      detalle.push({
        id_lote: lot.id_lote,
        cantidad: Number(consumed.toFixed(2)),
        costo_unitario: Number(lot.costo_unitario)
      });
    }
    if (remaining > 0) {
      const error = new Error('No hay existencia suficiente para registrar esta salida.');
      error.statusCode = 409;
      throw error;
    }
    await connection.execute(
      'UPDATE inventario SET stock_actual = stock_actual - ? WHERE id_material = ?',
      [movementQuantity, materialId]
    );
    return { costo: cost, detalle };
  }

  await connection.execute(
    'INSERT INTO inventario_lotes (id_material, cantidad_inicial, cantidad_disponible, costo_unitario) VALUES (?, ?, ?, ?)',
    [materialId, movementQuantity, movementQuantity, defaultCost]
  );
  await connection.execute(
    'UPDATE inventario SET stock_actual = stock_actual + ? WHERE id_material = ?',
    [movementQuantity, materialId]
  );
  return { costo: Number((movementQuantity * defaultCost).toFixed(2)), detalle: [] };
}

app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json({ limit: `${jsonBodyLimitMb}mb` }));

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
app.use(['/api/usuarios', '/api/auth/usuarios'], requireAdministrator);

async function crearUsuario(request, response) {
  const { nombre, usuario, email, contrasena, rol = 'Operador' } = request.body;
  const userEmail = String(email || '').trim();
  if (!nombre || !userEmail || !contrasena) {
    return response.status(400).json({
      message: 'Nombre, correo electrónico y contraseña son obligatorios.',
      errors: !userEmail ? { correo: 'El correo electrónico es obligatorio.' } : undefined
    });
  }
  try {
    const hash = await bcrypt.hash(contrasena, 12);
    const [result] = await pool.execute(
      'INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)',
      [nombre, userEmail, hash, rol]
    );
    response.status(201).json({ id: result.insertId, id_usuario: result.insertId, message: 'Usuario creado correctamente.' });
  } catch (error) {
    const isDuplicateEmail = error.code === 'ER_DUP_ENTRY';
    response.status(isDuplicateEmail ? 409 : 500).json({
      message: isDuplicateEmail ? 'El correo electrónico ya está registrado.' : 'No fue posible crear el usuario.',
      ...(isDuplicateEmail ? { errors: { correo: 'Este correo electrónico ya existe en la base de datos.' } } : {})
    });
  }
}

app.post('/api/usuarios', crearUsuario);
app.post('/api/auth/usuarios', crearUsuario);

app.get('/api/usuarios', async (request, response) => {
  try {
    await ensureArchiveSupport();
    const archiveState = request.query.estado === 'Archivado' ? 'Archivado' : 'Activo';
    const [rows] = await pool.query(`
      SELECT
        id_usuario AS id,
        id_usuario,
        nombre,
        email AS correo,
        email,
        rol,
        estado,
        estado_archivado,
        fecha_creacion
      FROM usuarios
      WHERE estado_archivado = ?
      ORDER BY nombre ASC
    `, [archiveState]);
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
  if (!['Activo', 'Inactivo'].includes(estado)) {
    return response.status(400).json({ message: 'El estado debe ser Activo o Inactivo.' });
  }
  if (Number(request.user?.sub) === Number(request.params.id) && estado === 'Inactivo') {
    return response.status(409).json({ message: 'No puede desactivar el usuario con el que inició sesión.' });
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

app.delete('/api/usuarios/:id', requireAdministratorForDelete, async (request, response) => {
  const connection = await pool.getConnection();
  try {
    await ensureUserDeleteAuditTrigger();
    if (Number(request.user?.sub) === Number(request.params.id)) {
      connection.release();
      return response.status(409).json({ message: 'No puede eliminar el usuario con el que inició sesión.' });
    }

    await connection.beginTransaction();
    await connection.execute('SET @usuario_responsable = ?', [request.user.sub]);
    const [projectRows] = await connection.execute(
      'SELECT COUNT(*) AS total FROM proyectos WHERE id_usuario = ?',
      [request.params.id]
    );
    if (Number(projectRows[0]?.total || 0) > 0) {
      await connection.rollback();
      connection.release();
      return response.status(409).json({
        message: 'No se puede eliminar este usuario porque tiene proyectos asociados. Puede cambiar su estado a Inactivo.'
      });
    }

    const [result] = await connection.execute('DELETE FROM usuarios WHERE id_usuario = ?', [request.params.id]);
    if (result.affectedRows === 0) {
      await connection.rollback();
      connection.release();
      return response.status(404).json({ message: 'Usuario no encontrado.' });
    }
    await connection.commit();
    connection.release();
    response.json({ message: 'Usuario eliminado correctamente.' });
  } catch (error) {
    await connection.rollback();
    connection.release();
    const isReferencedUser = error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED';
    response.status(isReferencedUser ? 409 : 500).json({
      message: isReferencedUser
        ? 'No se puede eliminar este usuario porque tiene registros asociados. Puede cambiar su estado a Inactivo.'
        : 'No fue posible eliminar el usuario.'
    });
  }
});

app.get('/api/clientes', async (request, response) => {
  try {
    await ensureArchiveSupport();
    const archiveState = request.query.estado === 'Archivado' ? 'Archivado' : 'Activo';
    const [rows] = await pool.query('SELECT * FROM clientes WHERE estado_archivado = ? ORDER BY id_cliente DESC', [archiveState]);
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
  const { nombre, identificacion, telefono, correo, direccion, notas, id_usuario, usuario_id, usuario } = request.body;
  const sessionUserId = getSessionFromRequest(request)?.sub ?? null;
  const requestedUserId = id_usuario || usuario_id || usuario || null;
  if (!nombre || !identificacion || !telefono) return response.status(400).json({ message: 'Nombre, identificación y teléfono son obligatorios.' });
  try {
    const finalUserId = await resolveValidUserId(pool, sessionUserId, requestedUserId);
    const [result] = await pool.execute(
      'INSERT INTO clientes (id_usuario, nombre, identificacion, telefono, correo, direccion, notas) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [finalUserId, nombre, identificacion, telefono, correo || null, direccion || null, notas || null]
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
  const { nombre, identificacion, telefono, correo, direccion, notas, id_usuario, usuario_id, usuario } = request.body;
  const sessionUserId = getSessionFromRequest(request)?.sub ?? null;
  const requestedUserId = id_usuario || usuario_id || usuario || null;
  if (!nombre || !identificacion || !telefono) return response.status(400).json({ message: 'Nombre, identificación y teléfono son obligatorios.' });
  try {
    const finalUserId = await resolveValidUserId(pool, sessionUserId, requestedUserId);
    const [result] = await pool.execute(
      `UPDATE clientes
       SET id_usuario = ?, nombre = ?, identificacion = ?, telefono = ?, correo = ?, direccion = ?, notas = ?
       WHERE id_cliente = ?`,
      [finalUserId, nombre, identificacion, telefono, correo || null, direccion || null, notas || null, request.params.id]
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

app.delete('/api/clientes/:id', requireAdministratorForDelete, async (request, response) => {
  try {
    const [result] = await pool.execute('DELETE FROM clientes WHERE id_cliente = ?', [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Cliente no encontrado.' });
    response.json({ message: 'Cliente eliminado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible eliminar el cliente.' });
  }
});

app.patch('/api/clientes/:id/archivar', async (request, response) => {
  try {
    await ensureArchiveSupport();
    const [result] = await pool.execute("UPDATE clientes SET estado_archivado = 'Archivado' WHERE id_cliente = ?", [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Cliente no encontrado.' });
    response.json({ message: 'Cliente archivado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible archivar el cliente.' });
  }
});

app.patch('/api/clientes/:id/desarchivar', async (request, response) => {
  try {
    await ensureArchiveSupport();
    const [result] = await pool.execute("UPDATE clientes SET estado_archivado = 'Activo' WHERE id_cliente = ?", [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Cliente no encontrado.' });
    response.json({ message: 'Cliente desarchivado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible desarchivar el cliente.' });
  }
});

app.get('/api/materiales', async (request, response) => {
  try {
    await ensureMaterialCategorySupport();
    const state = request.query.estado === 'Archivado' ? 'Archivado' : 'Activo';
    const [rows] = await pool.query(`
      SELECT
        m.id_material AS id,
        m.id_material,
        m.codigo,
        m.nombre,
        m.marca,
        m.color,
        m.codigo_color,
        m.tipo AS categoria,
        m.tipo,
        m.unidad_medida AS unidad,
        m.unidad_medida,
        m.rendimiento_m2_gal AS rendimiento,
        m.rendimiento_m2_gal,
        m.precio_unitario AS costo,
        m.precio_unitario,
        m.precio_venta,
        m.modo_uso,
        m.usos_estimados,
        m.precio_uso,
        m.descripcion,
        m.imagen,
        COALESCE(i.stock_minimo, 0) AS stock_minimo
      FROM materiales m
      LEFT JOIN inventario i ON i.id_material = m.id_material
      WHERE m.estado = ?
      ORDER BY m.id_material DESC
    `, [state]);
    response.json(rows);
  } catch (error) {
    console.error('Error al consultar materiales:', error);
    response.status(500).json({ message: 'No fue posible consultar los materiales.' });
  }
});

app.get('/api/materiales/categorias', async (_request, response) => {
  try {
    await ensureMaterialCategorySupport();
    const [rows] = await pool.query('SELECT id_categoria AS id, nombre, prefijo_codigo FROM material_categorias ORDER BY nombre ASC');
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar las categorías.' });
  }
});

app.post('/api/materiales/categorias', async (request, response) => {
  const nombre = String(request.body.nombre || '').trim();
  const prefijoCodigo = String(request.body.prefijo_codigo || '').trim();
  if (!nombre) return response.status(400).json({ message: 'El nombre de la categoría es obligatorio.' });

  try {
    await ensureMaterialCategorySupport();
    const finalPrefijo = prefijoCodigo ? prefijoCodigo.replace(/[^A-Za-z]/g, '').slice(0, 10).toUpperCase() : nombre.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'MAT';
    const [result] = await pool.execute('INSERT INTO material_categorias (nombre, prefijo_codigo) VALUES (?, ?)', [nombre, finalPrefijo]);
    response.status(201).json({ id: result.insertId, nombre, prefijo_codigo: finalPrefijo, message: 'Categoría guardada correctamente.' });
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
  const prefijoCodigo = String(request.body.prefijo_codigo || '').trim();
  if (!nombre) return response.status(400).json({ message: 'El nombre de la categoría es obligatorio.' });

  const connection = await pool.getConnection();
  try {
    await ensureMaterialCategorySupport();
    await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT nombre, prefijo_codigo FROM material_categorias WHERE id_categoria = ?', [request.params.id]);
    if (!rows[0]) {
      await connection.rollback();
      return response.status(404).json({ message: 'Categoría no encontrada.' });
    }

    const previousName = rows[0].nombre;
    const finalPrefijo = prefijoCodigo ? prefijoCodigo.replace(/[^A-Za-z]/g, '').slice(0, 10).toUpperCase() : (rows[0].prefijo_codigo || nombre.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'MAT');
    await connection.execute('UPDATE material_categorias SET nombre = ?, prefijo_codigo = ? WHERE id_categoria = ?', [nombre, finalPrefijo, request.params.id]);
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

app.delete('/api/materiales/categorias/:id', requireAdministratorForDelete, async (request, response) => {
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

app.get('/api/materiales/:id/variaciones', async (request, response) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        m.id_material AS id,
        m.nombre,
        m.color,
        m.codigo_color,
        COALESCE(i.stock_actual, 0) AS stock_actual
      FROM materiales actual
      JOIN materiales m
        ON m.marca <=> actual.marca
        AND m.tipo = actual.tipo
        AND m.descripcion <=> actual.descripcion
        AND m.estado = 'Activo'
      LEFT JOIN inventario i
        ON i.id_material = m.id_material
      WHERE actual.id_material = ?
      ORDER BY m.id_material ASC
    `, [request.params.id]);
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar las variaciones de color.' });
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
        m.marca,
        m.color,
        m.codigo_color,
        m.tipo AS categoria,
        m.tipo,
        m.unidad_medida AS unidad,
        m.unidad_medida,
        m.rendimiento_m2_gal AS rendimiento,
        m.rendimiento_m2_gal,
        m.precio_unitario AS costo,
        m.precio_unitario,
        m.precio_venta,
        m.modo_uso,
        m.usos_estimados,
        m.precio_uso,
        m.descripcion,
        m.imagen,
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
    precio_venta,
    modo_uso,
    usos_estimados,
    precio_uso,
    stock_minimo,
    registrar_inventario,
    stock_inicial,
    referencia_inventario,
    descripcion,
    marca,
    color,
    codigo_color,
    variaciones,
    id_usuario,
    usuario_id,
    usuario,
    id_categoria,
    categoria_id,
    imagen
  } = request.body;
  const materialTipo = categoria || tipo;
  const unidadMedida = unidad || unidad_medida || 'Galón';
  const rendimientoMaterial = Number(rendimiento ?? rendimiento_m2_gal ?? 0);
  const precioUnitario = Number(costo ?? precio_unitario ?? 0);
  const precioVenta = precio_venta === undefined || precio_venta === null || precio_venta === ''
    ? precioUnitario
    : Number(precio_venta);
  const modoUso = modo_uso === 'Reutilizable' ? 'Reutilizable' : 'Consumible';
  const usosEstimados = Number(usos_estimados ?? 1);
  const precioUso = Number(precio_uso ?? 0);
  const stockMinimo = stock_minimo || 0;
  const sessionUserId = getSessionFromRequest(request)?.sub ?? null;
  const requestedUserId = id_usuario || usuario_id || usuario || null;
  const isLabor = String(materialTipo || '').trim().toLowerCase() === 'mano de obra';
  const shouldRegisterInventory = !isLabor;
  const initialStock = Number(stock_inicial || 0);
  const hasMarca = String(marca || '').trim().length > 0;
  const hasCosto = costo !== undefined && costo !== null && String(costo).trim() !== ''
    || precio_unitario !== undefined && precio_unitario !== null && String(precio_unitario).trim() !== '';
  const hasStockMinimo = stock_minimo !== undefined && stock_minimo !== null && String(stock_minimo).trim() !== '';
  const variationList = Array.isArray(variaciones) && variaciones.length
    ? variaciones
    : [{ color, codigo_color }];

  if (!isValidMaterialImage(imagen)) {
    return response.status(400).json({ message: `La imagen debe ser JPG, PNG o WebP y no superar ${materialImageMaxMb} MB.` });
  }

  await ensureMaterialCategorySupport();
  await ensureInventorySupport();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const finalUserId = await resolveValidUserId(connection, sessionUserId, requestedUserId);
    const categoryId = await resolveMaterialCategoryId(connection, id_categoria ?? categoria_id ?? categoria ?? tipo, materialTipo);

    if (!nombre || !materialTipo || !unidadMedida) {
      await connection.rollback();
      return response.status(400).json({ message: 'Nombre, categoría y unidad son obligatorios.' });
    }

    if (modoUso === 'Reutilizable' && (isLabor || !Number.isInteger(usosEstimados) || usosEstimados < 1 || !Number.isFinite(precioUso) || precioUso < 0 || variationList.length > 1)) {
      await connection.rollback();
      return response.status(400).json({ message: 'La herramienta requiere usos estimados válidos y no admite variaciones de color.' });
    }

    if (!isLabor && (!hasMarca || !hasCosto || !hasStockMinimo || !imagen)) {
      await connection.rollback();
      return response.status(400).json({ message: 'Marca, imagen, costo unitario, stock mínimo y cantidad inicial son obligatorios.' });
    }

    if (shouldRegisterInventory && variationList.some((variation) => {
      const quantity = Number(variation?.stock_inicial ?? initialStock);
      return !Number.isFinite(quantity) || quantity <= 0;
    })) {
      await connection.rollback();
      return response.status(400).json({ message: 'La cantidad inicial de cada variación debe ser mayor a cero.' });
    }

    const createdIds = [];
    const generatedCodes = new Set();

    for (const variation of variationList) {
      const variationColor = String(variation?.color || '').trim() || null;
      const variationCode = String(variation?.codigo_color || '').trim() || null;
      const variationName = variationColor ? `${nombre} - ${variationColor}` : nombre;
      let finalCodigo = await generateMaterialCode(connection, categoryId ?? (id_categoria ?? categoria_id ?? categoria ?? tipo), materialTipo);
      while (generatedCodes.has(finalCodigo)) {
        finalCodigo = nextMaterialCodeFrom(finalCodigo);
      }
      generatedCodes.add(finalCodigo);
      const [result] = await connection.execute(
        'INSERT INTO materiales (id_usuario, id_categoria, codigo, nombre, marca, color, codigo_color, tipo, rendimiento_m2_gal, precio_unitario, precio_venta, modo_uso, usos_estimados, precio_uso, unidad_medida, descripcion, imagen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [finalUserId, categoryId, finalCodigo, variationName, marca || null, variationColor, variationCode, materialTipo, rendimientoMaterial, precioUnitario, precioVenta, modoUso, usosEstimados, precioUso, unidadMedida, descripcion || null, imagen || null]
      );
      createdIds.push(result.insertId);
      if (!isLabor) {
        await connection.execute(
          'INSERT INTO inventario (id_usuario, id_material, stock_actual, stock_minimo) VALUES (?, ?, 0, ?)',
          [finalUserId, result.insertId, stockMinimo]
        );
      }

      if (shouldRegisterInventory) {
        const variationStock = Number(variation?.stock_inicial ?? initialStock);
        await applyInventoryDelta(connection, result.insertId, 'Entrada', variationStock, 1, Number(precioUnitario));
        await connection.execute(
          'INSERT INTO movimientos_inventario (material_id, id_usuario, tipo, fecha, cantidad, referencia, notas) VALUES (?, ?, ?, CURDATE(), ?, ?, ?)',
          [result.insertId, finalUserId, 'Entrada', variationStock, referencia_inventario || 'Inventario inicial', 'Registro creado desde materiales']
        );
      }
    }

    await connection.commit();
    response.status(201).json({
      ids: createdIds,
      id: createdIds[0],
      variaciones_creadas: createdIds.length,
      message: shouldRegisterInventory
        ? 'Material guardado y entrada inicial registrada correctamente.'
        : 'Material guardado correctamente.'
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error al guardar material:', error);
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
  const { codigo, nombre, marca, color, codigo_color, categoria, tipo, unidad, unidad_medida, rendimiento, rendimiento_m2_gal, costo, precio_unitario, precio_venta, modo_uso, usos_estimados, precio_uso, stock_minimo, descripcion, id_usuario, usuario_id, usuario, id_categoria, categoria_id, imagen } = request.body;
  const materialTipo = categoria || tipo;
  const unidadMedida = unidad || unidad_medida || 'Galón';
  const rendimientoMaterial = Number(rendimiento ?? rendimiento_m2_gal ?? 0);
  const precioUnitario = Number(costo ?? precio_unitario ?? 0);
  const precioVenta = precio_venta === undefined || precio_venta === null || precio_venta === ''
    ? precioUnitario
    : Number(precio_venta);
  let modoUso = modo_uso === 'Reutilizable' ? 'Reutilizable' : 'Consumible';
  const usosEstimados = Number(usos_estimados ?? 1);
  const precioUso = Number(precio_uso ?? 0);
  const stockMinimo = stock_minimo || 0;
  const sessionUserId = getSessionFromRequest(request)?.sub ?? null;
  const requestedUserId = id_usuario || usuario_id || usuario || null;
  const isLabor = String(materialTipo || '').trim().toLowerCase() === 'mano de obra';
  const hasMarca = String(marca || '').trim().length > 0;
  const hasCosto = costo !== undefined && costo !== null && String(costo).trim() !== ''
    || precio_unitario !== undefined && precio_unitario !== null && String(precio_unitario).trim() !== '';
  const hasStockMinimo = stock_minimo !== undefined && stock_minimo !== null && String(stock_minimo).trim() !== '';

  if (!isValidMaterialImage(imagen)) {
    return response.status(400).json({ message: `La imagen debe ser JPG, PNG o WebP y no superar ${materialImageMaxMb} MB.` });
  }

  await ensureMaterialCategorySupport();
  await ensureProjectSupport();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const finalUserId = await resolveValidUserId(connection, sessionUserId, requestedUserId);
    const [currentMaterial] = await connection.execute(
      'SELECT codigo, modo_uso, usos_estimados, precio_uso FROM materiales WHERE id_material = ? LIMIT 1',
      [request.params.id]
    );
    if (modo_uso === undefined) modoUso = currentMaterial[0]?.modo_uso || 'Consumible';
    const finalUsosEstimados = usos_estimados === undefined ? Number(currentMaterial[0]?.usos_estimados || 1) : usosEstimados;
    const finalPrecioUso = precio_uso === undefined ? Number(currentMaterial[0]?.precio_uso || 0) : precioUso;

    const categoryId = await resolveMaterialCategoryId(connection, id_categoria ?? categoria_id ?? categoria ?? tipo, materialTipo);
    const finalCodigo = currentMaterial[0]?.codigo || "";

    if (!nombre || !materialTipo || !unidadMedida) {
      await connection.rollback();
      return response.status(400).json({ message: 'Nombre, categoría y unidad son obligatorios.' });
    }

    if (modoUso === 'Reutilizable' && (isLabor || !Number.isInteger(finalUsosEstimados) || finalUsosEstimados < 1 || !Number.isFinite(finalPrecioUso) || finalPrecioUso < 0)) {
      await connection.rollback();
      return response.status(400).json({ message: 'Los usos estimados y el precio por uso deben ser válidos.' });
    }
    if (currentMaterial[0]?.modo_uso !== modoUso) {
      const [usageRows] = await connection.execute('SELECT (SELECT COUNT(*) FROM proyecto_materiales WHERE id_material = ?) + (SELECT COUNT(*) FROM proyecto_herramientas WHERE id_material = ?) AS total', [request.params.id, request.params.id]);
      if (Number(usageRows[0]?.total || 0) > 0) {
        await connection.rollback();
        return response.status(409).json({ message: 'No se puede cambiar el modo de uso de un artículo ya asignado a proyectos.' });
      }
    }

    if (!isLabor && (!hasMarca || !hasCosto || !hasStockMinimo || !imagen)) {
      await connection.rollback();
      return response.status(400).json({ message: 'Marca, imagen, costo unitario y stock mínimo son obligatorios.' });
    }

    const [result] = await connection.execute(
      `UPDATE materiales
          SET id_usuario = ?, id_categoria = ?, codigo = ?, nombre = ?, marca = ?, color = ?, codigo_color = ?, tipo = ?, rendimiento_m2_gal = ?, precio_unitario = ?, precio_venta = ?, modo_uso = ?, usos_estimados = ?, precio_uso = ?, unidad_medida = ?, descripcion = ?, imagen = ?
       WHERE id_material = ?`,
            [finalUserId, categoryId, finalCodigo, nombre, marca || null, color || null, codigo_color || null, materialTipo, rendimientoMaterial, precioUnitario, precioVenta, modoUso, finalUsosEstimados, finalPrecioUso, unidadMedida, descripcion || null, imagen || null, request.params.id]
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      return response.status(404).json({ message: 'Material no encontrado.' });
    }

    const [inventoryResult] = isLabor
      ? [{ affectedRows: 1 }]
      : await connection.execute(
        'UPDATE inventario SET id_usuario = ?, stock_minimo = ? WHERE id_material = ?',
        [finalUserId, stockMinimo, request.params.id]
      );

    if (!isLabor && inventoryResult.affectedRows === 0) {
      await connection.execute(
        'INSERT INTO inventario (id_usuario, id_material, stock_actual, stock_minimo) VALUES (?, ?, 0, ?)',
        [finalUserId, request.params.id, stockMinimo]
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

app.delete('/api/materiales/:id', requireAdministratorForDelete, async (request, response) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [materialRows] = await connection.execute('SELECT id_material FROM materiales WHERE id_material = ? FOR UPDATE', [request.params.id]);
    if (!materialRows[0]) {
      await connection.rollback();
      return response.status(404).json({ message: 'Material no encontrado.' });
    }
    await connection.execute('DELETE FROM proyecto_materiales WHERE id_material = ?', [request.params.id]);
    await connection.execute('DELETE FROM movimientos_inventario WHERE material_id = ?', [request.params.id]);
    await connection.execute('DELETE FROM inventario_lotes WHERE id_material = ?', [request.params.id]);
    await connection.execute('DELETE FROM inventario WHERE id_material = ?', [request.params.id]);
    await connection.execute('DELETE FROM materiales WHERE id_material = ?', [request.params.id]);
    await connection.commit();
    response.json({ message: 'Material eliminado correctamente.' });
  } catch (error) {
    await connection.rollback();
    response.status(error.code === 'ER_ROW_IS_REFERENCED_2' ? 409 : 500).json({
      message: error.code === 'ER_ROW_IS_REFERENCED_2'
        ? 'No se puede eliminar el material porque tiene movimientos asociados.'
        : 'No fue posible eliminar el material.'
    });
  } finally {
    connection.release();
  }
});

app.patch('/api/materiales/:id/archivar', async (request, response) => {
  try {
    const [result] = await pool.execute("UPDATE materiales SET estado = 'Archivado' WHERE id_material = ?", [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Material no encontrado.' });
    response.json({ message: 'Material archivado. Sus movimientos se conservaron.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible archivar el material.' });
  }
});

app.patch('/api/materiales/:id/desarchivar', async (request, response) => {
  try {
    const [result] = await pool.execute("UPDATE materiales SET estado = 'Activo' WHERE id_material = ?", [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Material no encontrado.' });
    response.json({ message: 'Material desarchivado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible desarchivar el material.' });
  }
});

app.get('/api/proyectos', async (request, response) => {
  try {
    await ensureProjectSupport();
    await ensureArchiveSupport();
    const archiveState = request.query.estado === 'Archivado' ? 'Archivado' : 'Activo';
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
        p.id_mano_obra,
        p.mano_obra_precio_m2,
        mano_obra.nombre AS mano_obra_nombre,
        p.descripcion,
        p.estado,
        p.estado_archivado,
        p.costo_materiales,
        p.costo_herramientas,
        p.precio_herramientas,
        p.costo_mano_obra,
        p.precio_mano_obra,
        p.costo_total,
        p.precio_cotizacion,
        p.costo_estimado AS presupuesto,
        p.costo_estimado,
        p.fecha_inicio,
        p.fecha_creacion,
        c.nombre AS cliente_nombre
      FROM proyectos p
      LEFT JOIN clientes c ON c.id_cliente = p.id_cliente
      LEFT JOIN materiales mano_obra ON mano_obra.id_material = p.id_mano_obra
      WHERE p.estado_archivado = ?
      ORDER BY p.id_proyecto DESC
    `, [archiveState]);
    response.json(rows);
  } catch (error) {
    console.error('Error al consultar proyectos:', error);
    response.status(500).json({ message: 'No fue posible consultar los proyectos.' });
  }
});

app.get('/api/dashboard/summary', async (_request, response) => {
  try {
    await ensureProjectSupport();
    await ensureInventorySupport();
    await ensureArchiveSupport();

    const [clientesRows] = await pool.execute("SELECT COUNT(*) AS total FROM clientes WHERE estado_archivado = 'Activo'");
    const [proyectosRows] = await pool.execute("SELECT COUNT(*) AS total FROM proyectos WHERE estado_archivado = 'Activo'");
    const [materialesRows] = await pool.execute("SELECT COUNT(*) AS total FROM materiales WHERE estado = 'Activo'");
    const [alertasRows] = await pool.execute(`
      SELECT COUNT(*) AS total
      FROM inventario i
      WHERE i.stock_actual <= i.stock_minimo
    `);

    response.json({
      clientes: Number(clientesRows[0]?.total ?? 0),
      proyectos: Number(proyectosRows[0]?.total ?? 0),
      materiales: Number(materialesRows[0]?.total ?? 0),
      alertas: Number(alertasRows[0]?.total ?? 0),
      clientesLabel: 'Registros actuales',
      proyectosLabel: 'En seguimiento',
      materialesLabel: 'Disponibles',
      alertasLabel: 'Requieren revisión'
    });
  } catch (error) {
    console.error('Error al consultar resumen del dashboard:', error);
    response.status(500).json({ message: 'No fue posible consultar el resumen del panel principal.' });
  }
});

app.get('/api/reportes', async (request, response) => {
  const { tipo, desde, hasta, estado } = request.query;
  const definitions = {
    'Clientes registrados': {
      columns: ['ID', 'Nombre', 'Identificación', 'Teléfono', 'Correo', 'Dirección', 'Fecha de registro'],
      sql: 'SELECT id_cliente, nombre, identificacion, telefono, correo, direccion, fecha_registro FROM clientes WHERE 1 = 1',
      dateColumn: 'fecha_registro'
    },
    'Proyectos por estado': {
      columns: ['ID', 'Proyecto', 'Cliente', 'Estado', 'Área (m²)', 'Costo estimado', 'Fecha de inicio'],
      sql: 'SELECT p.id_proyecto, p.nombre_proyecto, c.nombre AS cliente, p.estado, p.area_m2, p.costo_estimado, p.fecha_inicio FROM proyectos p JOIN clientes c ON c.id_cliente = p.id_cliente WHERE 1 = 1',
      dateColumn: 'p.fecha_inicio'
    },
    'Inventario actual': {
      columns: ['ID', 'Código', 'Material', 'Unidad', 'Existencia', 'Mínimo', 'Estado'],
      sql: "SELECT i.id_inventario, m.codigo, m.nombre, m.unidad_medida, i.stock_actual, i.stock_minimo, CASE WHEN i.stock_actual <= i.stock_minimo THEN 'Stock mínimo' ELSE 'Existencia normal' END AS estado FROM inventario i JOIN materiales m ON m.id_material = i.id_material WHERE 1 = 1"
    },
    'Movimientos de inventario': {
      columns: ['ID', 'Material', 'Tipo', 'Fecha', 'Cantidad', 'Referencia', 'Notas'],
      sql: 'SELECT mi.id_movimiento, m.nombre, mi.tipo, mi.fecha, mi.cantidad, mi.referencia, mi.notas FROM movimientos_inventario mi JOIN materiales m ON m.id_material = mi.material_id WHERE 1 = 1',
      dateColumn: 'mi.fecha'
    },
    'Consumo de materiales': {
      columns: ['Material', 'Código', 'Cantidad consumida', 'Costo total'],
      sql: 'SELECT m.nombre, m.codigo, SUM(pm.cantidad_calculada) AS cantidad_consumida, SUM(pm.costo_subtotal) AS costo_total FROM proyecto_materiales pm JOIN materiales m ON m.id_material = pm.id_material JOIN proyectos p ON p.id_proyecto = pm.id_proyecto WHERE 1 = 1 GROUP BY pm.id_material, m.nombre, m.codigo',
      dateColumn: 'p.fecha_inicio'
    }
  };
  const definition = definitions[tipo];
  if (!definition) return response.status(400).json({ message: 'Tipo de reporte no válido.' });
  if (desde && !/^\d{4}-\d{2}-\d{2}$/.test(desde)) return response.status(400).json({ message: 'La fecha inicial no es válida.' });
  if (hasta && !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) return response.status(400).json({ message: 'La fecha final no es válida.' });
  if (desde && hasta && desde > hasta) return response.status(400).json({ message: 'La fecha inicial no puede ser posterior a la fecha final.' });

  const parameters = [];
  let sql = definition.sql;
  if (definition.dateColumn && desde) { sql += ` AND ${definition.dateColumn} >= ?`; parameters.push(desde); }
  if (definition.dateColumn && hasta) { sql += ` AND ${definition.dateColumn} < DATE_ADD(?, INTERVAL 1 DAY)`; parameters.push(hasta); }
  if (tipo === 'Proyectos por estado' && estado) { sql += ' AND p.estado = ?'; parameters.push(estado); }
  sql += tipo === 'Consumo de materiales' ? ' ORDER BY cantidad_consumida DESC' : ' ORDER BY 1 DESC';

  try {
    if (tipo.toLowerCase().includes('inventario')) await ensureInventorySupport();
    if (tipo.includes('Proyectos') || tipo === 'Consumo de materiales') await ensureProjectSupport();
    const [rows] = await pool.execute(sql, parameters);
    response.json({ tipo, columnas: definition.columns, filas: rows, total: rows.length });
  } catch (error) {
    console.error('Error al generar reporte:', error);
    response.status(500).json({ message: 'No fue posible generar el reporte.' });
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
        p.id_mano_obra,
        p.mano_obra_precio_m2,
        mano_obra.nombre AS mano_obra_nombre,
        p.descripcion,
        p.estado,
        p.costo_materiales,
        p.costo_herramientas,
        p.precio_herramientas,
        p.costo_mano_obra,
        p.precio_mano_obra,
        p.costo_total,
        p.precio_cotizacion,
        p.costo_estimado AS presupuesto,
        p.costo_estimado,
        p.fecha_inicio,
        p.fecha_creacion,
        c.nombre AS cliente_nombre
      FROM proyectos p
      LEFT JOIN clientes c ON c.id_cliente = p.id_cliente
      LEFT JOIN materiales mano_obra ON mano_obra.id_material = p.id_mano_obra
      WHERE p.id_proyecto = ?`, [request.params.id]);
    if (!rows[0]) return response.status(404).json({ message: 'Proyecto no encontrado.' });

    const [materialRows] = await pool.execute(`
      SELECT pm.id_detalle, pm.id_material, m.nombre AS material_nombre, pm.cantidad_calculada, pm.costo_subtotal, pm.precio_subtotal, pm.detalle_peps, m.precio_unitario, m.precio_venta
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
      SELECT pm.id_detalle, pm.id_material, m.nombre AS material_nombre, pm.cantidad_calculada, pm.costo_subtotal, pm.precio_subtotal, pm.detalle_peps, m.precio_unitario, m.precio_venta
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

app.get('/api/herramientas/disponibilidad', async (_request, response) => {
  try {
    await ensureMaterialCategorySupport();
    await ensureProjectSupport();
    const [rows] = await pool.execute(`
      SELECT m.id_material, m.nombre, m.codigo, m.precio_unitario, m.precio_uso, m.usos_estimados,
             COALESCE(i.stock_actual, 0) AS stock_actual,
             COALESCE(SUM(ph.cantidad - ph.devueltas - ph.dadas_baja), 0) AS prestadas,
             COALESCE(i.stock_actual, 0) - COALESCE(SUM(ph.cantidad - ph.devueltas - ph.dadas_baja), 0) AS disponibles
      FROM materiales m
      LEFT JOIN inventario i ON i.id_material = m.id_material
      LEFT JOIN proyecto_herramientas ph ON ph.id_material = m.id_material
      WHERE m.modo_uso = 'Reutilizable' AND m.estado = 'Activo'
      GROUP BY m.id_material, m.nombre, m.codigo, m.precio_unitario, m.precio_uso, m.usos_estimados, i.stock_actual
      ORDER BY m.nombre
    `);
    response.json(rows);
  } catch (error) {
    console.error('Error al consultar herramientas:', error);
    response.status(500).json({ message: 'No fue posible consultar las herramientas.' });
  }
});

app.get('/api/proyectos/:id/herramientas', async (request, response) => {
  try {
    await ensureProjectSupport();
    const [rows] = await pool.execute(`
      SELECT ph.*, m.nombre AS material_nombre, m.codigo,
             ph.cantidad - ph.devueltas - ph.dadas_baja AS pendientes
      FROM proyecto_herramientas ph JOIN materiales m ON m.id_material = ph.id_material
      WHERE ph.id_proyecto = ? ORDER BY ph.id_asignacion DESC
    `, [request.params.id]);
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar las herramientas del proyecto.' });
  }
});

app.post('/api/proyectos/:id/herramientas/:asignacionId/movimiento', async (request, response) => {
  await ensureProjectSupport();
  const quantity = Number(request.body?.cantidad);
  const type = request.body?.tipo;
  if (!Number.isInteger(quantity) || quantity < 1 || !['Devolucion', 'Baja'].includes(type)) {
    return response.status(400).json({ message: 'Indique un tipo y una cantidad válidos.' });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [lookup] = await connection.execute(
      'SELECT id_material FROM proyecto_herramientas WHERE id_asignacion = ? AND id_proyecto = ?',
      [request.params.asignacionId, request.params.id]
    );
    if (!lookup[0]) throw Object.assign(new Error('Asignación no encontrada.'), { statusCode: 404 });
    const [materialRows] = await connection.execute(`
      SELECT m.precio_venta, i.stock_actual FROM materiales m
      JOIN inventario i ON i.id_material = m.id_material WHERE m.id_material = ? FOR UPDATE
    `, [lookup[0].id_material]);
    const [rows] = await connection.execute(
      'SELECT * FROM proyecto_herramientas WHERE id_asignacion = ? AND id_proyecto = ? FOR UPDATE',
      [request.params.asignacionId, request.params.id]
    );
    const assignment = rows[0];
    if (!assignment || quantity > assignment.cantidad - assignment.devueltas - assignment.dadas_baja) {
      throw Object.assign(new Error('La cantidad excede las unidades pendientes de devolución.'), { statusCode: 409 });
    }
    if (type === 'Devolucion') {
      await connection.execute('UPDATE proyecto_herramientas SET devueltas = devueltas + ? WHERE id_asignacion = ?', [quantity, assignment.id_asignacion]);
    } else {
      const salida = await applyInventoryDelta(connection, assignment.id_material, 'Salida', quantity, 1, null, true);
      const replacementPrice = request.body?.cobrar_reposicion === true ? quantity * Number(materialRows[0]?.precio_venta || 0) : 0;
      await connection.execute(`
        UPDATE proyecto_herramientas SET dadas_baja = dadas_baja + ?, costo_baja = costo_baja + ?, precio_baja = precio_baja + ?
        WHERE id_asignacion = ?
      `, [quantity, Number(salida.costo.toFixed(2)), Number(replacementPrice.toFixed(2)), assignment.id_asignacion]);
      await connection.execute(`
        INSERT INTO movimientos_inventario (material_id, id_usuario, tipo, fecha, cantidad, referencia, notas)
        VALUES (?, ?, 'Salida', CURDATE(), ?, ?, 'Herramienta dada de baja en proyecto')
      `, [assignment.id_material, getSessionFromRequest(request)?.sub ?? null, quantity, `Proyecto #${request.params.id}`]);
    }
    await syncProjectMaterialSummary(connection, Number(request.params.id));
    await connection.commit();
    response.json({ message: type === 'Devolucion' ? 'Herramienta devuelta.' : 'Baja registrada.' });
  } catch (error) {
    await connection.rollback();
    response.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'No fue posible registrar el movimiento.' });
  } finally {
    connection.release();
  }
});

app.post('/api/proyectos/:id/materiales', async (request, response) => {
  const connection = await pool.getConnection();
  try {
    await ensureProjectSupport();
    const projectId = Number(request.params.id);
    const { id_material, cantidad, precio_unitario, id_usuario, usuario_id, usuario } = request.body || {};
    const materialId = Number(id_material ?? 0);
    const quantity = Number(cantidad ?? 0);
    const sessionUserId = getSessionFromRequest(request)?.sub ?? null;
    const finalUserId = id_usuario || usuario_id || usuario || sessionUserId || null;

    if (!projectId || !materialId || !Number.isFinite(quantity) || quantity <= 0) {
      return response.status(400).json({ message: 'Material y cantidad válidos son obligatorios.' });
    }

    const [projectRows] = await connection.execute(
      'SELECT nombre_proyecto FROM proyectos WHERE id_proyecto = ? LIMIT 1',
      [projectId]
    );
    if (!projectRows[0]) {
      connection.release();
      return response.status(404).json({ message: 'Proyecto no encontrado.' });
    }

    const [materialRows] = await connection.execute(
      "SELECT precio_unitario, precio_venta FROM materiales WHERE id_material = ? AND modo_uso = 'Consumible' LIMIT 1",
      [materialId]
    );

    if (!materialRows[0]) {
      connection.release();
      return response.status(404).json({ message: 'Material no encontrado.' });
    }

    await connection.beginTransaction();
    const salida = await applyInventoryDelta(connection, materialId, 'Salida', quantity);
    const subtotal = Number(salida.costo.toFixed(2));
    const precioSubtotal = Number((quantity * Number(materialRows[0].precio_venta ?? materialRows[0].precio_unitario ?? 0)).toFixed(2));
    await connection.execute(
      'INSERT INTO movimientos_inventario (material_id, id_usuario, tipo, fecha, cantidad, referencia, notas) VALUES (?, ?, ?, CURDATE(), ?, ?, ?)',
      [materialId, finalUserId, 'Salida', quantity, `Proyecto: ${projectRows[0].nombre_proyecto}`, 'Material asignado al proyecto']
    );
    await connection.execute(
      `INSERT INTO proyecto_materiales (id_usuario, id_proyecto, id_material, cantidad_calculada, costo_subtotal, precio_subtotal, detalle_peps)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [finalUserId, projectId, materialId, quantity, subtotal, precioSubtotal, JSON.stringify(salida.detalle)]
    );

    await syncProjectMaterialSummary(connection, projectId);
    await connection.commit();
    connection.release();
    response.status(201).json({ message: 'Material agregado al proyecto correctamente.' });
  } catch (error) {
    await connection.rollback();
    connection.release();
    response.status(error.statusCode || 500).json({ message: error.message || 'No fue posible guardar el material del proyecto.' });
  }
});

app.delete('/api/proyectos/:id/materiales/:detalleId', requireAdministratorForDelete, async (request, response) => {
  const connection = await pool.getConnection();
  try {
    await ensureProjectSupport();
    const [rows] = await connection.execute(
      `SELECT pm.id_material, pm.cantidad_calculada, p.nombre_proyecto
       FROM proyecto_materiales pm JOIN proyectos p ON p.id_proyecto = pm.id_proyecto
       WHERE pm.id_proyecto = ? AND pm.id_detalle = ?`,
      [request.params.id, request.params.detalleId]
    );

    if (!rows[0]) {
      connection.release();
      return response.status(404).json({ message: 'Material del proyecto no encontrado.' });
    }

    await connection.beginTransaction();
    await applyInventoryDelta(connection, rows[0].id_material, 'Entrada', rows[0].cantidad_calculada);
    await connection.execute(
      'INSERT INTO movimientos_inventario (material_id, id_usuario, tipo, fecha, cantidad, referencia, notas) VALUES (?, ?, ?, CURDATE(), ?, ?, ?)',
      [rows[0].id_material, request.user?.sub || null, 'Entrada', rows[0].cantidad_calculada, `Reversión proyecto: ${rows[0].nombre_proyecto}`, 'Material retirado de la asignación del proyecto']
    );
    await connection.execute(
      'DELETE FROM proyecto_materiales WHERE id_proyecto = ? AND id_detalle = ?',
      [request.params.id, request.params.detalleId]
    );
    await syncProjectMaterialSummary(connection, Number(request.params.id));
    await connection.commit();
    connection.release();
    response.json({ message: 'Material del proyecto eliminado correctamente.' });
  } catch (error) {
    await connection.rollback();
    connection.release();
    response.status(error.statusCode || 500).json({ message: error.message || 'No fue posible eliminar el material del proyecto.' });
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
  await ensureMaterialCategorySupport();
  await ensureProjectSupport();
  const { nombre, nombre_proyecto, id_cliente, cliente_id, id_usuario, usuario_id, estado, fecha_inicio, fechaInicio, largo, area_m2, altura, tipo, id_mano_obra, presupuesto, costo_estimado, descripcion, materiales, herramientas } = request.body;
  const finalNombre = nombre || nombre_proyecto;
  const finalClienteId = id_cliente || cliente_id;
  const finalUsuarioId = await resolveValidUserId(
    pool,
    getSessionFromRequest(request)?.sub ?? null,
    id_usuario || usuario_id
  );
  const finalFechaInicio = normalizeProjectDate(fecha_inicio ?? fechaInicio ?? null);
  const finalLargo = Number(largo ?? 0);
  const finalPresupuesto = presupuesto ?? costo_estimado ?? 0;
  const finalArea = area_m2 ?? (finalLargo && altura ? Number(finalLargo) * Number(altura) : 0);
  const finalDescripcion = descripcion ?? null;
  const finalEstado = 'Pendiente';

  if (!finalNombre || !finalClienteId || !finalUsuarioId || !finalLargo || !finalArea) {
    return response.status(400).json({ message: 'Nombre, cliente, usuario, largo y área son obligatorios.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    let laborPriceM2 = 0;
    let laborClientPriceM2 = 0;
    if (id_mano_obra) {
      const [laborRows] = await connection.execute(
        `SELECT precio_unitario, precio_venta FROM materiales WHERE id_material = ? AND LOWER(tipo) = 'mano de obra' LIMIT 1`,
        [id_mano_obra]
      );
      if (!laborRows[0]) throw Object.assign(new Error('El tipo de mano de obra seleccionado no es válido.'), { statusCode: 400 });
      laborPriceM2 = Number(laborRows[0].precio_unitario || 0);
      laborClientPriceM2 = Number(laborRows[0].precio_venta ?? laborRows[0].precio_unitario ?? 0);
    }
    const finalCostoManoObra = Number((Number(finalArea) * laborPriceM2).toFixed(2));
    const finalPrecioManoObra = Number((Number(finalArea) * (laborClientPriceM2 ?? laborPriceM2)).toFixed(2));
    const [result] = await connection.execute(
      `INSERT INTO proyectos (id_cliente, id_usuario, nombre_proyecto, largo, area_m2, altura, tipo, id_mano_obra, mano_obra_precio_m2, costo_mano_obra, precio_mano_obra, costo_total, precio_cotizacion, costo_estimado, fecha_inicio, descripcion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [finalClienteId, finalUsuarioId, finalNombre, finalLargo || null, finalArea, altura ?? null, tipo || null, id_mano_obra || null, laborPriceM2, finalCostoManoObra, finalPrecioManoObra, finalCostoManoObra, finalPrecioManoObra, finalPresupuesto || finalPrecioManoObra, finalFechaInicio || null, finalDescripcion || null]
    );

    const projectId = Number(result.insertId);
    if (Array.isArray(materiales) && materiales.length) {
      await upsertProjectMaterialRelations(connection, projectId, materiales, finalUsuarioId);
    }
    await assignProjectTools(connection, projectId, herramientas ?? []);
    await connection.commit();
    response.status(201).json({ id: projectId, id_proyecto: projectId, message: 'Proyecto guardado correctamente.' });
  } catch (error) {
    await connection.rollback();
    response.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'No fue posible guardar el proyecto.' });
  } finally {
    connection.release();
  }
});

app.put('/api/proyectos/:id', async (request, response) => {
  await ensureMaterialCategorySupport();
  await ensureProjectSupport();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existingRows] = await connection.execute(`
      SELECT *
      FROM proyectos
      WHERE id_proyecto = ?
    `, [request.params.id]);

    if (!existingRows[0]) {
      await connection.rollback();
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
      id_mano_obra: incoming.id_mano_obra ?? currentProject.id_mano_obra,
      costo_mano_obra: incoming.costo_mano_obra ?? currentProject.costo_mano_obra ?? 0,
      precio_mano_obra: incoming.precio_mano_obra ?? currentProject.precio_mano_obra ?? 0,
      costo_estimado: incoming.costo_estimado ?? incoming.presupuesto ?? currentProject.costo_estimado,
      descripcion: incoming.descripcion ?? currentProject.descripcion,
      estado: incoming.estado ?? currentProject.estado ?? 'Pendiente'
    };

    const finalNombre = merged.nombre_proyecto || merged.nombre;
    const finalClienteId = merged.id_cliente;
    const finalUsuarioId = await resolveValidUserId(
      pool,
      getSessionFromRequest(request)?.sub ?? null,
      merged.id_usuario
    );
    const finalFechaInicio = normalizeProjectDate(merged.fecha_inicio ?? null);
    const finalLargo = Number(merged.largo ?? 0);
    const finalArea = Number(merged.area_m2 ?? (finalLargo && merged.altura ? Number(finalLargo) * Number(merged.altura) : 0));
    const finalPresupuesto = merged.costo_estimado ?? 0;
    const finalCostoMateriales = Number(merged.costo_materiales ?? currentProject.costo_materiales ?? 0);
    let laborPriceM2 = Number(merged.mano_obra_precio_m2 ?? currentProject.mano_obra_precio_m2 ?? 0);
    let laborClientPriceM2 = Number(merged.mano_obra_precio_cliente_m2 ?? laborPriceM2);
    if (merged.id_mano_obra) {
      const [laborRows] = await connection.execute(
        `SELECT precio_unitario, precio_venta FROM materiales WHERE id_material = ? AND LOWER(tipo) = 'mano de obra' LIMIT 1`,
        [merged.id_mano_obra]
      );
      if (!laborRows[0]) throw Object.assign(new Error('El tipo de mano de obra seleccionado no es válido.'), { statusCode: 400 });
      laborPriceM2 = Number(laborRows[0].precio_unitario || 0);
      laborClientPriceM2 = Number(laborRows[0].precio_venta ?? laborPriceM2);
    }
    const finalCostoManoObra = Number((Number(finalArea) * laborPriceM2).toFixed(2));
    const finalPrecioManoObra = Number((Number(finalArea) * laborClientPriceM2).toFixed(2));
    const finalCostoTotal = finalCostoMateriales + finalCostoManoObra;
    const finalPrecioCotizacion = finalCostoMateriales + finalPrecioManoObra;
    const finalDescripcion = merged.descripcion ?? null;
    const finalEstado = merged.estado || 'Pendiente';

    if (!finalNombre || !finalClienteId || !finalUsuarioId || !finalLargo || !finalArea || !Number.isFinite(finalCostoMateriales) || finalCostoMateriales < 0 || !Number.isFinite(finalCostoManoObra) || finalCostoManoObra < 0 || !Number.isFinite(finalPrecioManoObra) || finalPrecioManoObra < 0) {
      await connection.rollback();
      return response.status(400).json({ message: 'Nombre, cliente, usuario, largo y área son obligatorios.' });
    }

    const [result] = await connection.execute(
      `UPDATE proyectos
      SET id_cliente = ?, id_usuario = ?, nombre_proyecto = ?, largo = ?, area_m2 = ?, altura = ?, tipo = ?, id_mano_obra = ?, mano_obra_precio_m2 = ?, estado = ?, costo_materiales = ?, costo_mano_obra = ?, precio_mano_obra = ?, costo_total = ?, precio_cotizacion = ?, costo_estimado = ?, fecha_inicio = ?, descripcion = ?
       WHERE id_proyecto = ?`,
          [finalClienteId, finalUsuarioId, finalNombre, finalLargo || null, finalArea, merged.altura ?? null, merged.tipo || null, merged.id_mano_obra || null, laborPriceM2, finalEstado, finalCostoMateriales, finalCostoManoObra, finalPrecioManoObra, finalCostoTotal, finalPrecioCotizacion, finalPresupuesto || finalPrecioCotizacion, finalFechaInicio || null, finalDescripcion || null, request.params.id]
    );

    if (result.affectedRows === 0) return response.status(404).json({ message: 'Proyecto no encontrado.' });

    if (Array.isArray(request.body.materiales)) {
      await upsertProjectMaterialRelations(connection, Number(request.params.id), request.body.materiales, finalUsuarioId);
    }
    await assignProjectTools(connection, Number(request.params.id), request.body.herramientas ?? []);
    await connection.commit();
    response.json({ message: 'Proyecto actualizado correctamente.' });
  } catch (error) {
    await connection.rollback();
    response.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'No fue posible actualizar el proyecto.' });
  } finally {
    connection.release();
  }
});

app.delete('/api/proyectos/:id', requireAdministratorForDelete, async (request, response) => {
  try {
    await ensureProjectSupport();
    const [loanRows] = await pool.execute('SELECT COALESCE(SUM(cantidad - devueltas - dadas_baja), 0) AS pendientes FROM proyecto_herramientas WHERE id_proyecto = ?', [request.params.id]);
    if (Number(loanRows[0]?.pendientes || 0) > 0) return response.status(409).json({ message: 'Devuelva o dé de baja las herramientas antes de eliminar el proyecto.' });
    const [result] = await pool.execute('DELETE FROM proyectos WHERE id_proyecto = ?', [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Proyecto no encontrado.' });
    response.json({ message: 'Proyecto eliminado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible eliminar el proyecto.' });
  }
});

app.patch('/api/proyectos/:id/archivar', async (request, response) => {
  try {
    await ensureArchiveSupport();
    const [rows] = await pool.execute('SELECT estado FROM proyectos WHERE id_proyecto = ?', [request.params.id]);
    if (!rows[0]) return response.status(404).json({ message: 'Proyecto no encontrado.' });
    if (rows[0].estado !== 'Finalizado') {
      return response.status(409).json({ message: 'Solo se pueden archivar proyectos finalizados.' });
    }
    await pool.execute("UPDATE proyectos SET estado_archivado = 'Archivado' WHERE id_proyecto = ?", [request.params.id]);
    response.json({ message: 'Proyecto archivado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible archivar el proyecto.' });
  }
});

app.patch('/api/proyectos/:id/desarchivar', async (request, response) => {
  try {
    await ensureArchiveSupport();
    const [result] = await pool.execute("UPDATE proyectos SET estado_archivado = 'Activo' WHERE id_proyecto = ?", [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Proyecto no encontrado.' });
    response.json({ message: 'Proyecto desarchivado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible desarchivar el proyecto.' });
  }
});

app.patch('/api/usuarios/:id/archivar', async (request, response) => {
  try {
    await ensureArchiveSupport();
    if (Number(request.user?.sub) === Number(request.params.id)) {
      return response.status(409).json({ message: 'No puede archivar el usuario con el que inició sesión.' });
    }
    const [result] = await pool.execute("UPDATE usuarios SET estado_archivado = 'Archivado' WHERE id_usuario = ?", [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Usuario no encontrado.' });
    response.json({ message: 'Usuario archivado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible archivar el usuario.' });
  }
});

app.patch('/api/usuarios/:id/desarchivar', async (request, response) => {
  try {
    await ensureArchiveSupport();
    const [result] = await pool.execute("UPDATE usuarios SET estado_archivado = 'Activo' WHERE id_usuario = ?", [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Usuario no encontrado.' });
    response.json({ message: 'Usuario desarchivado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible desarchivar el usuario.' });
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
      WHERE LOWER(m.tipo) <> 'mano de obra'
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
      WHERE LOWER(a.tipo) <> 'mano de obra'
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
  const { material_id, material, id_usuario, usuario_id, usuario, tipo, fecha, cantidad, costo_unitario, referencia, notas, observacion } = request.body;
  const materialId = material_id || material;
  const movementNotes = notas || observacion;
  const unitCost = costo_unitario === '' || costo_unitario === null || costo_unitario === undefined
    ? null
    : Number(costo_unitario);
  if (!materialId || !tipo || !fecha || !cantidad) return response.status(400).json({ message: 'Material, tipo, fecha y cantidad son obligatorios.' });
  if (String(tipo).toLowerCase() === 'entrada' && (!Number.isFinite(unitCost) || unitCost < 0)) return response.status(400).json({ message: 'El costo unitario es obligatorio para una entrada.' });
  await ensureInventorySupport();
  await ensureProjectSupport();
  const connection = await pool.getConnection();
  try {
    const userId = await resolveValidUserId(
      connection,
      getSessionFromRequest(request)?.sub ?? null,
      id_usuario || usuario_id || usuario
    );
    const [materialRows] = await connection.execute(
      'SELECT tipo FROM materiales WHERE id_material = ? LIMIT 1',
      [materialId]
    );
    if (!materialRows[0]) {
      return response.status(404).json({ message: 'Material no encontrado.' });
    }
    if (String(materialRows[0].tipo).toLowerCase() === 'mano de obra') {
      return response.status(400).json({ message: 'La mano de obra no utiliza movimientos de inventario.' });
    }
    await connection.beginTransaction();
    const effectiveCost = Number.isFinite(unitCost) ? unitCost : null;
    await applyInventoryDelta(connection, materialId, tipo, cantidad, 1, effectiveCost);
    const [result] = await connection.execute(
      'INSERT INTO movimientos_inventario (material_id, id_usuario, tipo, fecha, cantidad, costo_unitario, referencia, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [materialId, userId, tipo, fecha, cantidad, effectiveCost ?? 0, referencia || null, movementNotes || null]
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
  const { material_id, material, id_usuario, usuario_id, usuario, tipo, fecha, cantidad, costo_unitario, referencia, notas, observacion } = request.body;
  const materialId = material_id || material;
  const movementNotes = notas || observacion;
  const unitCost = Number(costo_unitario ?? 0);
  if (!materialId || !tipo || !fecha || !cantidad) return response.status(400).json({ message: 'Material, tipo, fecha y cantidad son obligatorios.' });
  if (!Number.isFinite(unitCost) || unitCost < 0) return response.status(400).json({ message: 'El costo unitario debe ser válido.' });
  await ensureInventorySupport();
  await ensureProjectSupport();
  const connection = await pool.getConnection();
  try {
    const userId = await resolveValidUserId(
      connection,
      getSessionFromRequest(request)?.sub ?? null,
      id_usuario || usuario_id || usuario
    );
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT material_id, tipo, cantidad, costo_unitario FROM movimientos_inventario WHERE id_movimiento = ? FOR UPDATE',
      [request.params.id]
    );
    if (!rows[0]) {
      await connection.rollback();
      return response.status(404).json({ message: 'Movimiento no encontrado.' });
    }

    await applyInventoryDelta(connection, rows[0].material_id, rows[0].tipo, rows[0].cantidad, -1);
    await applyInventoryDelta(connection, materialId, tipo, cantidad, 1, unitCost);
    const [result] = await connection.execute(
      `UPDATE movimientos_inventario
      SET material_id = ?, id_usuario = ?, tipo = ?, fecha = ?, cantidad = ?, costo_unitario = ?, referencia = ?, notas = ?
       WHERE id_movimiento = ?`,
          [materialId, userId, tipo, fecha, cantidad, unitCost, referencia || null, movementNotes || null, request.params.id]
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

app.delete('/api/inventario/movimientos/:id', requireAdministratorForDelete, async (request, response) => {
  await ensureInventorySupport();
  await ensureProjectSupport();
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

