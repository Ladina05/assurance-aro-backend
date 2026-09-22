require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./prismaClient');
const authRoutes = require('./routes/auth');
const compteursRoutes = require('./routes/compteurs');
const sousCompteursRoutes = require('./routes/sousCompteurs');
const facturesRoutes = require('./routes/factures');
const paymentBatchesRoutes = require('./routes/paymentBatches');
const statistiquesRoutes = require('./routes/statistiques');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

app.use('/api/auth', authRoutes);
app.use('/api/compteurs', compteursRoutes);
app.use('/api/souscompteurs', sousCompteursRoutes);
app.use('/api/factures', facturesRoutes);
app.use('/api/payment-batches', paymentBatchesRoutes);
app.use('/api/statistiques', statistiquesRoutes);

app.listen(PORT, async () => {
  console.log(`✅ Serveur démarré sur http://localhost:${PORT}`);
  try {
    await prisma.$connect();
    console.log('✅ Prisma connecté à PostgreSQL');
  } catch (err) {
    console.error('❌ Erreur connexion Prisma:', err);
  }
});
