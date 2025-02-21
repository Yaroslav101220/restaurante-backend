const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const ExcelJS = require('exceljs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: ['https://lightgray-rabbit-711267.hostingersite.com'],
        methods: ['GET', 'POST']
    }
});

// Archivos de datos
const MENU_FILE = path.join(__dirname, 'menu.json');
const HISTORICO_FILE = path.join(__dirname, 'historico.json');
const EXCEL_DIR = path.join(__dirname, 'archivos_excel');

// Crear directorio para Excel si no existe
if (!fs.existsSync(EXCEL_DIR)) {
    fs.mkdirSync(EXCEL_DIR);
}

// Cargar datos
let menu = cargarDatos(MENU_FILE);
let historico = cargarDatos(HISTORICO_FILE);
let ordenes = [];
let contadorPedidos = 1;

// Función para cargar datos desde archivos JSON
function cargarDatos(archivo) {
    try {
        return JSON.parse(fs.readFileSync(archivo, 'utf8'));
    } catch (error) {
        fs.writeFileSync(archivo, '[]');
        return [];
    }
}

// Función para guardar el menú
const saveMenu = () => fs.writeFileSync(MENU_FILE, JSON.stringify(menu, null, 2));

// Configuración de CORS
app.use(cors({
    origin: ['https://lightgray-rabbit-711267.hostingersite.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));
app.use(express.json());

// Middleware de autenticación
const basicAuth = (userEnv, passEnv) => (req, res, next) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    
    if (login === process.env[userEnv] && password === process.env[passEnv]) {
        return next();
    }
    
    res.status(401).json({ 
        error: "Autenticación requerida",
        code: "UNAUTHORIZED"
    });
};

// Endpoints de la API
app.get('/menu', (req, res) => res.json(menu));

app.post('/menu', basicAuth('ADMIN_USER', 'ADMIN_PASS'), (req, res) => {
    const requiredFields = ['nombre', 'categoria', 'imagen', 'precioCop', 'precioUsd', 'descripcion'];
    
    if (!requiredFields.every(field => req.body[field])) {
        return res.status(400).json({ error: "Faltan campos obligatorios" });
    }

    const newProduct = {
        id: Date.now(),
        ...req.body
    };

    menu.push(newProduct);
    saveMenu();
    io.emit('menu-actualizado', newProduct);
    res.status(201).json(newProduct);
});

app.put('/menu/:id', basicAuth('ADMIN_USER', 'ADMIN_PASS'), (req, res) => {
    const { id } = req.params;
    const productIndex = menu.findIndex(p => p.id == id);
    
    if (productIndex === -1) return res.status(404).json({ error: "Producto no encontrado" });
    
    menu[productIndex] = { ...menu[productIndex], ...req.body };
    saveMenu();
    io.emit('menu-actualizado', menu[productIndex]);
    res.json(menu[productIndex]);
});

app.delete('/menu/:id', basicAuth('ADMIN_USER', 'ADMIN_PASS'), (req, res) => {
    menu = menu.filter(p => p.id != req.params.id);
    saveMenu();
    io.emit('menu-actualizado', { id: req.params.id });
    res.sendStatus(204);
});

// Endpoints para órdenes
app.get('/ordenes', (req, res) => res.json(ordenes));

app.post('/orden', (req, res) => {
    if (!validarPedido(req.body.pedido)) {
        return res.status(400).json({ error: "Formato de pedido inválido" });
    }

    const newOrder = {
        ...req.body,
        id: `PED-${String(contadorPedidos).padStart(3, '0')}`,
        status: 'preparando',
        prioridad: req.body.pedido.some(item => item.nombre?.toLowerCase().includes('bebida')) ? 'baja' : 'alta',
        timestamp: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
        mesa: req.body.mesa || '0'
    };

    contadorPedidos++;
    ordenes.unshift(newOrder);
    io.emit('nueva-orden', newOrder);
    res.sendStatus(200);
});

app.put('/orden/:id', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    const orderIndex = ordenes.findIndex(o => o.id == id);
    if (orderIndex !== -1) {
        ordenes[orderIndex].status = status;
        io.emit('actualizar-estado', { id: id, status });
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Endpoints para reportes
app.get('/descargar-excel', (req, res) => {
    const nombreArchivo = `pedidos_${new Date().toISOString().split('T')[0]}.xlsx`;
    const rutaArchivo = path.join(EXCEL_DIR, nombreArchivo);

    fs.existsSync(rutaArchivo) 
        ? res.download(rutaArchivo)
        : res.status(404).json({ error: "No hay registros para hoy" });
});

app.get('/historico', basicAuth('ADMIN_USER', 'ADMIN_PASS'), (req, res) => {
    res.json(historico);
});

// Función para validar pedidos
function validarPedido(pedido) {
    return Array.isArray(pedido) && pedido.every(item => 
        item.nombre && item.precioCop && item.precioUsd && item.cantidad
    );
}

// Tareas programadas
setInterval(() => {
    exportarPedidosAExcel();
    historico = [...historico, ...ordenes.map(pedido => ({ ...pedido, fecha: new Date().toISOString().split('T')[0] }))];
    fs.writeFileSync(HISTORICO_FILE, JSON.stringify(historico, null, 2));
    ordenes = [];
    contadorPedidos = 1;
}, 24 * 60 * 60 * 1000); // Cada 24 horas

// Función para exportar a Excel
function exportarPedidosAExcel() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Pedidos');

    worksheet.columns = [
        { header: 'ID Pedido', width: 15 },
        { header: 'Mesa', width: 10 },
        { header: 'Productos', width: 35 },
        { header: 'Cantidad Total', width: 15 },
        { header: 'Total COP', width: 15 },
        { header: 'Total USD', width: 15 },
        { header: 'Hora Pedido', width: 20 },
        { header: 'Estado', width: 15 }
    ];

    ordenes.forEach(pedido => {
        worksheet.addRow([
            pedido.id,
            pedido.mesa,
            pedido.pedido.map(item => `${item.nombre} (x${item.cantidad})`).join('\n'),
            pedido.pedido.reduce((total, item) => total + item.cantidad, 0),
            pedido.pedido.reduce((total, item) => total + (item.precioCop * item.cantidad), 0),
            pedido.pedido.reduce((total, item) => total + (item.precioUsd * item.cantidad), 0).toFixed(2),
            pedido.timestamp,
            pedido.status
        ]);
    });

    const rutaArchivo = path.join(EXCEL_DIR, `pedidos_${new Date().toISOString().split('T')[0]}.xlsx`);
    
    workbook.xlsx.writeFile(rutaArchivo)
        .then(() => console.log(`📊 Reporte generado: ${path.basename(rutaArchivo)}`))
        .catch(error => console.error('Error al generar Excel:', error));
}

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`📌 Endpoints disponibles:`);
    console.log(`- Menú: https://restaurante-backend-rsxq.onrender.com/menu`);
    console.log(`- Órdenes: https://restaurante-backend-rsxq.onrender.com/ordenes`);
    console.log(`- Histórico: https://restaurante-backend-rsxq.onrender.com/historico`);
    console.log(`- Reportes: https://restaurante-backend-rsxq.onrender.com/descargar-excel`);
});
