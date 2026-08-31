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
    const [rows] = await pool.execute(
      'SELECT id, nombre, usuario, contrasena, rol FROM usuarios WHERE usuario = ? AND activo = TRUE LIMIT 1',
      [usuario]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(contrasena, user.contrasena))) {
      return response.status(401).json({ message: 'Las credenciales no son válidas.' });
    }
    response.json({ user: { id: user.id, nombre: user.nombre, usuario: user.usuario, rol: user.rol } });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar la base de datos.' });
  }
});

app.post('/api/auth/usuarios', async (request, response) => {
  const { nombre, usuario, contrasena, rol = 'Vendedor' } = request.body;
  if (!nombre || !usuario || !contrasena) return response.status(400).json({ message: 'Nombre, usuario y contraseña son obligatorios.' });
  try {
    const hash = await bcrypt.hash(contrasena, 12);
    const [result] = await pool.execute(
      'INSERT INTO usuarios (nombre, usuario, contrasena, rol) VALUES (?, ?, ?, ?)',
      [nombre, usuario, hash, rol]
    );
    response.status(201).json({ id: result.insertId, message: 'Usuario creado correctamente.' });
  } catch (error) {
    response.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: 'No fue posible crear el usuario.' });
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
    const [rows] = await pool.query('SELECT * FROM materiales ORDER BY id DESC');
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar los materiales.' });
  }
});

app.get('/api/materiales/:id', async (request, response) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM materiales WHERE id = ?', [request.params.id]);
    if (!rows[0]) return response.status(404).json({ message: 'Material no encontrado.' });
    response.json(rows[0]);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar el material.' });
  }
});

app.post('/api/materiales', async (request, response) => {
  const { nombre, categoria, unidad, rendimiento, costo, stock_minimo, marca } = request.body;
  if (!nombre || !categoria || !unidad) return response.status(400).json({ message: 'Nombre, categoría y unidad son obligatorios.' });
  try {
    const [result] = await pool.execute(
      'INSERT INTO materiales (nombre, categoria, unidad, rendimiento, costo, stock_minimo, marca) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nombre, categoria, unidad, rendimiento || 0, costo || 0, stock_minimo || 0, marca || null]
    );
    response.status(201).json({ id: result.insertId, message: 'Material guardado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible guardar el material.' });
  }
});

app.put('/api/materiales/:id', async (request, response) => {
  const { nombre, categoria, unidad, rendimiento, costo, stock_minimo, marca } = request.body;
  if (!nombre || !categoria || !unidad) return response.status(400).json({ message: 'Nombre, categoría y unidad son obligatorios.' });
  try {
    const [result] = await pool.execute(
      `UPDATE materiales
       SET nombre = ?, categoria = ?, unidad = ?, rendimiento = ?, costo = ?, stock_minimo = ?, marca = ?
       WHERE id = ?`,
      [nombre, categoria, unidad, rendimiento || 0, costo || 0, stock_minimo || 0, marca || null, request.params.id]
    );
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Material no encontrado.' });
    response.json({ message: 'Material actualizado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible actualizar el material.' });
  }
});

app.delete('/api/materiales/:id', async (request, response) => {
  try {
    const [result] = await pool.execute('DELETE FROM materiales WHERE id = ?', [request.params.id]);
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

app.get('/api/inventario/movimientos', async (_request, response) => {
  try {
    const [rows] = await pool.query(`
      SELECT m.*, a.nombre AS material_nombre
      FROM movimientos_inventario m INNER JOIN materiales a ON a.id = m.material_id
      ORDER BY m.fecha DESC, m.id DESC
    `);
    response.json(rows);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar los movimientos.' });
  }
});

app.get('/api/inventario/movimientos/:id', async (request, response) => {
  try {
    const [rows] = await pool.execute(`
      SELECT m.*, a.nombre AS material_nombre
      FROM movimientos_inventario m INNER JOIN materiales a ON a.id = m.material_id
      WHERE m.id = ?`, [request.params.id]);
    if (!rows[0]) return response.status(404).json({ message: 'Movimiento no encontrado.' });
    response.json(rows[0]);
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible consultar el movimiento.' });
  }
});

app.post('/api/inventario/movimientos', async (request, response) => {
  const { material_id, tipo, fecha, cantidad, referencia, notas } = request.body;
  if (!material_id || !tipo || !fecha || !cantidad) return response.status(400).json({ message: 'Material, tipo, fecha y cantidad son obligatorios.' });
  try {
    const [result] = await pool.execute(
      'INSERT INTO movimientos_inventario (material_id, tipo, fecha, cantidad, referencia, notas) VALUES (?, ?, ?, ?, ?, ?)',
      [material_id, tipo, fecha, cantidad, referencia || null, notas || null]
    );
    response.status(201).json({ id: result.insertId, message: 'Movimiento guardado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible guardar el movimiento.' });
  }
});

app.put('/api/inventario/movimientos/:id', async (request, response) => {
  const { material_id, tipo, fecha, cantidad, referencia, notas } = request.body;
  if (!material_id || !tipo || !fecha || !cantidad) return response.status(400).json({ message: 'Material, tipo, fecha y cantidad son obligatorios.' });
  try {
    const [result] = await pool.execute(
      `UPDATE movimientos_inventario
       SET material_id = ?, tipo = ?, fecha = ?, cantidad = ?, referencia = ?, notas = ?
       WHERE id = ?`,
      [material_id, tipo, fecha, cantidad, referencia || null, notas || null, request.params.id]
    );
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Movimiento no encontrado.' });
    response.json({ message: 'Movimiento actualizado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible actualizar el movimiento.' });
  }
});

app.delete('/api/inventario/movimientos/:id', async (request, response) => {
  try {
    const [result] = await pool.execute('DELETE FROM movimientos_inventario WHERE id = ?', [request.params.id]);
    if (result.affectedRows === 0) return response.status(404).json({ message: 'Movimiento no encontrado.' });
    response.json({ message: 'Movimiento eliminado correctamente.' });
  } catch (_error) {
    response.status(500).json({ message: 'No fue posible eliminar el movimiento.' });
  }
});

app.use((_request, response) => response.status(404).json({ message: 'Ruta no encontrada.' }));

app.listen(port, () => console.log(`API disponible en http://localhost:${port}`));
