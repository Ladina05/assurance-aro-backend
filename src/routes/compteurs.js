const express = require('express');
const prisma = require('../prismaClient');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const loueParam = req.query.loue;
    const where = {};
    if (loueParam === 'true') where.loue = true;
    if (loueParam === 'false') where.loue = false;

    const compteurs = await prisma.compteur.findMany({
      where,
      include: {
        sousCompteurs: {
          include: {
            factures: {
              where: {
                payee: false
              }
            }
          }
        }
      },
      orderBy: { id: 'asc' }
    });
    res.json(compteurs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

router.post('/', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
  try {
    const { quartier, localisation, loue, codeImmeuble, codeLocal, nomPropriete, rg, typeBien, province, adresse, sousCompteurs } = req.body;

    const newC = await prisma.compteur.create({
      data: {
        quartier,
        localisation,
        loue: !!loue,
        codeImmeuble,
        codeLocal,
        nomPropriete,
        rg,
        typeBien,
        province,
        adresse,
        sousCompteurs: sousCompteurs && sousCompteurs.length > 0 ? {
          create: sousCompteurs.map(sc => ({
            numeroCompteur: sc.numeroCompteur,
            typeCompteur: sc.typeCompteur || 'eau'
          }))
        } : undefined
      },
      include: { sousCompteurs: true }
    });
    res.status(201).json(newC);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: 'Erreur création compteur', detail: err.message });
  }
});

router.put('/:id', authenticate, requireRole(['ADMIN', 'INSERTEUR']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = req.body;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.compteur.update({
        where: { id },
        data: {
          quartier: data.quartier,
          localisation: data.localisation,
          loue: data.loue ?? undefined,
          codeImmeuble: data.codeImmeuble,
          codeLocal: data.codeLocal,
          nomPropriete: data.nomPropriete,
          rg: data.rg,
          typeBien: data.typeBien,
          province: data.province,
          adresse: data.adresse
        }
      });

      if (Array.isArray(data.sousCompteurs)) {
        const sousCompteursExistants = await tx.sousCompteur.findMany({
          where: { compteurId: id },
          include: { factures: true }
        });

        const nouveauxNumeros = data.sousCompteurs.map(sc => sc.numeroCompteur);
        const sousCompteursASupprimer = sousCompteursExistants.filter(sc =>
          !nouveauxNumeros.includes(sc.numeroCompteur)
        );

        for (const sc of sousCompteursASupprimer) {
          if (sc.factures && sc.factures.length > 0) {
            await tx.facture.deleteMany({
              where: { sousCompteurId: sc.id }
            });
          }
        }

        await tx.sousCompteur.deleteMany({
          where: {
            id: { in: sousCompteursASupprimer.map(sc => sc.id) }
          }
        });

        for (const scData of data.sousCompteurs) {
          const sousCompteurExistant = sousCompteursExistants.find(
            sc => sc.numeroCompteur === scData.numeroCompteur
          );

          if (sousCompteurExistant) {
            await tx.sousCompteur.update({
              where: { id: sousCompteurExistant.id },
              data: {
                typeCompteur: scData.typeCompteur || 'eau'
              }
            });
          } else {
            await tx.sousCompteur.create({
              data: {
                numeroCompteur: scData.numeroCompteur,
                typeCompteur: scData.typeCompteur || 'eau',
                compteurId: id
              }
            });
          }
        }
      }

      return tx.compteur.findUnique({
        where: { id },
        include: {
          sousCompteurs: {
            include: {
              factures: true
            }
          }
        }
      });
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(400).json({
      message: 'Erreur mise à jour compteur',
      detail: err.message
    });
  }
});

router.delete('/:id', authenticate, requireRole(['ADMIN']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.sousCompteur.deleteMany({ where: { compteurId: id } });
    await prisma.compteur.delete({ where: { id } });
    res.json({ message: 'Supprimé' });
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: 'Erreur suppression', detail: err.message });
  }
});

module.exports = router;
