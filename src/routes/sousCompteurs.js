const express = require('express');
const prisma = require('../prismaClient');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

router.post('/', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
  try {
    const { compteurId, numeroCompteur, numeroFacture, montant, moisFacture, anneeFacture } = req.body;
    const newSous = await prisma.sousCompteur.create({
      data: { compteurId, numeroCompteur, numeroFacture, montant, moisFacture, anneeFacture }
    });
    res.status(201).json(newSous);
  } catch (err) {
    res.status(400).json({ message: 'Erreur création sous-compteur', detail: err.message });
  }
});

router.put('/:id', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { numeroFacture, montant, moisFacture, anneeFacture } = req.body;
    const updated = await prisma.sousCompteur.update({
      where: { id },
      data: {
        numeroFacture: numeroFacture ?? null,
        montant: montant ?? null,
        moisFacture: moisFacture ?? null,
        anneeFacture: anneeFacture ?? null
      }
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: 'Erreur mise à jour sous-compteur', detail: err.message });
  }
});

module.exports = router;
