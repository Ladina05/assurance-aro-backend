const PDFDocument = require('pdfkit');
const prisma = require('../prismaClient');

async function writeBatchPdf(req, res) {
  try {
    const id = Number(req.params.id);
    const batch = await prisma.paymentBatch.findUnique({
      where: { id },
      include: {
        factures: {
          include: {
            sousCompteur: {
              include: {
                compteur: true
              }
            }
          }
        }
      }
    });
    if (!batch) return res.status(404).json({ message: 'Batch non trouvé' });

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=batch_${id}.pdf`);
    doc.pipe(res);

    // NOUVELLES COLONNES
    const startX = 15;
    const colWidths = [90, 80, 80, 80, 75, 100, 80];
    const headers = ['Propriété', 'Localisation', 'RG', 'Type', 'Mois/Année', 'N° Facture', 'Montant (Ar)'];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);

    const BASE_LINE_HEIGHT = 16;
    const EXTRA_HEIGHT_PER_LINE = 8;
    const SIGNATURES_HEIGHT_NEEDED = 150;
    const MIN_SPACE_FOR_CONTENT = 200; // Espace minimum requis avant de forcer un saut de page

    function formatMontant(valeur) {
      const montant = typeof valeur === 'number' ? valeur : 0;
      return montant.toLocaleString('fr-FR', {
        style: 'decimal',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: true
      }).replace(/\u202F/g, ' ');
    }

    function drawHorizontalLine(yPos) {
      doc.moveTo(startX, yPos).lineTo(startX + tableWidth, yPos).stroke();
    }

    function drawVerticalLines(yTop, yBottom) {
      let x = startX;
      for (let width of colWidths) {
        doc.moveTo(x, yTop).lineTo(x, yBottom).stroke();
        x += width;
      }
      doc.moveTo(startX + tableWidth, yTop).lineTo(startX + tableWidth, yBottom).stroke();
    }

    function checkPageBreak(neededHeight, forceSignaturePage = false) {
      const currentY = doc.y;
      const pageHeight = doc.page.height;
      const bottomMargin = 60;

      // Si on veut forcer les signatures sur la même page
      if (forceSignaturePage) {
        if (currentY + neededHeight > pageHeight - bottomMargin) {
          doc.addPage();
          return true;
        }
        return false;
      }

      // Vérifier s'il reste suffisamment d'espace pour le contenu + signatures
      const remainingSpace = pageHeight - currentY - bottomMargin;
      
      // Si l'espace restant est insuffisant pour le contenu OU s'il reste trop peu d'espace pour être utile
      if (currentY + neededHeight > pageHeight - bottomMargin || 
          remainingSpace < MIN_SPACE_FOR_CONTENT) {
        doc.addPage();
        return true;
      }
      return false;
    }

    function drawTableHeaders() {
      const y = doc.y + 10;

      doc.font('Helvetica-Bold').fontSize(11);
      drawHorizontalLine(y);
      let x = startX;
      headers.forEach((h, i) => {
        doc.text(h, x, y + 8, { width: colWidths[i], align: 'center' });
        x += colWidths[i];
      });
      doc.y = y + 25;
      drawHorizontalLine(doc.y);
      drawVerticalLines(y, doc.y);

      doc.font('Helvetica').fontSize(10);
      return doc.y;
    }

    function getCellHeight(text, columnIndex) {
      const maxWidth = colWidths[columnIndex] - 4;
      const lines = doc.heightOfString(text, {
        width: maxWidth,
        align: 'center'
      }) / BASE_LINE_HEIGHT;

      return Math.max(1, Math.ceil(lines)) * BASE_LINE_HEIGHT + EXTRA_HEIGHT_PER_LINE;
    }

    function getRowHeight(cells) {
      let maxHeight = BASE_LINE_HEIGHT;
      cells.forEach((text, i) => {
        const cellHeight = getCellHeight(text, i);
        if (cellHeight > maxHeight) {
          maxHeight = cellHeight;
        }
      });
      return maxHeight;
    }

    // ======== Logique de regroupement par numéro de facture ========
    const facturesGroupes = Object.values(
      (batch.factures ?? []).reduce((acc, f) => {
        const key = f.numeroFacture ?? `nofacture-${f.id}`;
        if (!acc[key]) {
          acc[key] = {
            ...f,
            typeCompteur: [f.sousCompteur.typeCompteur],
            numeroCompteur: [f.sousCompteur.numeroCompteur],
            montant: f.montant ?? 0,
            compteur: f.sousCompteur.compteur,
            mois: f.mois,
            annee: f.annee
          };
        } else {
          acc[key].typeCompteur.push(f.sousCompteur.typeCompteur);
          acc[key].numeroCompteur.push(f.sousCompteur.numeroCompteur);
          acc[key].montant += f.montant ?? 0;
        }
        return acc;
      }, {})
    );

    // Trier par propriété
    const paiementsTries = facturesGroupes.sort((a, b) => {
      const p1 = a.compteur.nomPropriete?.toLowerCase() || '';
      const p2 = b.compteur.nomPropriete?.toLowerCase() || '';
      return p1.localeCompare(p2);
    });

    const totalGeneral = paiementsTries.reduce((sum, p) => sum + (p.montant || 0), 0);

    // ======== En-tête PDF ========
    const dateBatch = new Date(batch.date);
    const moisPaiementBatch = batch.moisPaiement || new Date(batch.date).getMonth() + 1;
    const anneePaiementBatch = batch.anneePaiement || new Date(batch.date).getFullYear();

    const nomsMois = [
      'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'
    ];
    const nomMois = nomsMois[moisPaiementBatch - 1];

    doc.fontSize(14).font('Helvetica-Bold').text('Note: Département comptabilité Générales ARO', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).text(`OBJET: FACTURE JIRAMA MOIS de ${nomMois.toUpperCase()} ${anneePaiementBatch}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).text("Veuillez émettre à l'ordre de la JIRAMA un chèque de ", { continued: true });
    doc.font('Helvetica-Bold').text(`${formatMontant(totalGeneral)} Ariary`, { continued: true });
    doc.font('Helvetica').text(" en règlement des factures ci-après énumérées.", { align: 'left' });
    doc.moveDown(1.5);

    // ======== Tableau ========
    let y = drawTableHeaders();

    let currentPropriete = null;
    let sousTotal = 0;
    let yStartPropriete = y;
    let isNewPage = false;

    for (let i = 0; i < paiementsTries.length; i++) {
      const p = paiementsTries[i];
      const c = p.compteur;
      const propriete = c.nomPropriete || 'Non défini';

      const nomMoisFacture = nomsMois[p.mois - 1] || 'Mois inconnu';

      const cells = [
        propriete,
        c.localisation || '-',
        c.rg || '-',
        Array.isArray(p.typeCompteur) ? p.typeCompteur.join(' / ') : p.typeCompteur || '-',
        `${nomMoisFacture} ${p.annee}`,
        p.numeroFacture || 'N/A',
        formatMontant(p.montant)
      ];

      const rowHeight = getRowHeight(cells);

      // Vérifier s'il faut afficher le sous-total par propriété
      if (currentPropriete && currentPropriete !== propriete) {
        if (checkPageBreak(30)) {
          y = drawTableHeaders();
          yStartPropriete = y;
          isNewPage = true;
        }

        if (!isNewPage) {
          y += 6;
          drawHorizontalLine(y);
          y += 6;
          let x = startX;

          for (let j = 0; j < 5; j++) {
            doc.text('', x, y, { width: colWidths[j], align: 'center' });
            x += colWidths[j];
          }

          doc.font('Helvetica-Bold');
          doc.text(`Sous-total`, x, y, { width: colWidths[5], align: 'center' });
          x += colWidths[5];
          doc.text(formatMontant(sousTotal), x, y, { width: colWidths[6], align: 'center' });
          doc.font('Helvetica');

          y += 20;
          drawHorizontalLine(y);
          drawVerticalLines(yStartPropriete, y);
        } else {
          sousTotal = 0;
        }

        yStartPropriete = y;
        sousTotal = 0;
        isNewPage = false;
      }

      // Vérification optimisée du saut de page
      if (checkPageBreak(rowHeight)) {
        y = drawTableHeaders();
        yStartPropriete = y;
        isNewPage = true;
      }

      currentPropriete = propriete;
      sousTotal += p.montant || 0;

      // Ligne du paiement groupé
      y += 6;
      let x = startX;

      cells.forEach((text, i) => {
        doc.text(text, x, y + (rowHeight - BASE_LINE_HEIGHT) / 2, {
          width: colWidths[i],
          align: 'center',
          height: rowHeight
        });
        x += colWidths[i];
      });

      y += rowHeight;
      drawHorizontalLine(y);
      drawVerticalLines(y - rowHeight - 6, y);
    }

    // Afficher le dernier sous-total
    if (currentPropriete) {
      if (checkPageBreak(30)) {
        y = drawTableHeaders();
        yStartPropriete = y;
      }

      y += 6;
      drawHorizontalLine(y);
      y += 6;
      let x = startX;

      for (let i = 0; i < 5; i++) {
        doc.text('', x, y, { width: colWidths[i], align: 'center' });
        x += colWidths[i];
      }

      doc.font('Helvetica-Bold');
      doc.text(`Sous-total `, x, y, { width: colWidths[5], align: 'center' });
      x += colWidths[5];
      doc.text(formatMontant(sousTotal), x, y, { width: colWidths[6], align: 'center' });
      doc.font('Helvetica');

      y += 20;
      drawHorizontalLine(y);
      drawVerticalLines(yStartPropriete, y);
    }

    // Total général
    const yStartTotal = y;
    y += 6;
    drawHorizontalLine(y);
    y += 6;
    let x = startX;

    for (let i = 0; i < 5; i++) {
      doc.text('', x, y, { width: colWidths[i], align: 'center' });
      x += colWidths[i];
    }

    doc.font('Helvetica-Bold');
    doc.text('TOTAL GÉNÉRAL', x, y, { width: colWidths[5], align: 'center' });
    x += colWidths[5];
    doc.text(formatMontant(totalGeneral), x, y, { width: colWidths[6], align: 'center' });
    doc.font('Helvetica');

    y += 20;
    drawHorizontalLine(y);
    drawVerticalLines(yStartTotal, y);

    // Vérification FORCÉE pour s'assurer que les signatures sont sur la même page
    checkPageBreak(SIGNATURES_HEIGHT_NEEDED, true);

    function montantEnLettres(montant) {
      const chiffres = [
        '', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
        'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
        'dix-sept', 'dix-huit', 'dix-neuf'
      ];
      const dizaines = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];

      function convertirNombre(n, estCentime = false) {
        if (n === 0) return 'zéro';
        if (n < 20) return chiffres[n];
        if (n < 100) {
          let unite = n % 10;
          let dizaine = Math.floor(n / 10);

          if ((dizaine === 7 || dizaine === 9) && unite === 0) {
            return dizaines[dizaine];
          }
          if (dizaine === 8 && unite === 0) {
            return dizaines[dizaine] + 's';
          }
          if (dizaine === 7 || dizaine === 9) {
            return dizaines[dizaine] + '-' + chiffres[10 + unite];
          }

          let sep = (unite === 1 && dizaine !== 8) ? '-et-' : '-';
          if (unite === 0) return dizaines[dizaine];
          return dizaines[dizaine] + sep + chiffres[unite];
        }
        if (n < 1000) {
          let reste = n % 100;
          let centaine = Math.floor(n / 100);
          let texte = '';

          if (centaine > 1) {
            texte = chiffres[centaine] + ' cent';
            if (reste === 0) texte += 's';
          } else {
            texte = 'cent';
          }

          if (reste > 0) {
            texte += ' ' + convertirNombre(reste);
          }
          return texte;
        }

        const echelles = [
          { valeur: 1000000000000, nom: 'billion', pluriel: 'billions' },
          { valeur: 1000000000, nom: 'milliard', pluriel: 'milliards' },
          { valeur: 1000000, nom: 'million', pluriel: 'millions' },
          { valeur: 1000, nom: 'mille', pluriel: 'mille' }
        ];

        for (let echelle of echelles) {
          if (n >= echelle.valeur) {
            let quotient = Math.floor(n / echelle.valeur);
            let reste = n % echelle.valeur;

            let texte = '';
            if (quotient >= 1) {
              texte = convertirNombre(quotient) + ' ' + (quotient > 1 ? echelle.pluriel : echelle.nom);
            } else {
              texte = echelle.nom;
            }

            if (reste > 0) {
              if (echelle.valeur === 1000 && reste < 100) {
                texte += ' ';
              } else {
                texte += ' ';
              }
              texte += convertirNombre(reste);
            }

            return texte;
          }
        }

        return 'nombre trop grand';
      }

      const partieEntiere = Math.floor(montant);
      const centimes = Math.round((montant - partieEntiere) * 100);

      let result = convertirNombre(partieEntiere) + ' Ariary';

      if (centimes > 0) {
        let centimesTexte;
        if (centimes < 10) {
          centimesTexte = 'zéro ' + convertirNombre(centimes);
        } else {
          centimesTexte = convertirNombre(centimes);
        }

        result += ' ' + centimesTexte;
      }

      return result.charAt(0).toUpperCase() + result.slice(1);
    }

    // ===== Montant en lettres =====
    y += 17;
    doc.font('Helvetica-Bold').fontSize(12).text(
      `Montant Total : ${montantEnLettres(totalGeneral)}`,
      startX,
      y,
      { align: 'left' }
    );
    y += 25;

    // ===== SIGNATURES =====
    // Pas besoin de vérifier le saut de page ici car déjà fait avec forceSignaturePage
    y += 40;

    const signatures = [
      'Services Etudes et Travaux',
      'Responsable Administratif et Financier',
      'Tolotra RANDRIANALAINA',
      'Haingo RAZAFINIAINA'
    ];

    const sigColWidth = tableWidth / 2 + 20;
    doc.font('Helvetica').fontSize(11);

    // Première ligne de signatures
    doc.text(signatures[0], startX, y, { width: sigColWidth, align: 'center' });
    doc.text(signatures[1], startX + sigColWidth + 20, y, { width: sigColWidth, align: 'center' });

    // Deuxième ligne de signatures
    y += 80;
    doc.text(signatures[2], startX, y, { width: sigColWidth, align: 'center' });
    doc.text(signatures[3], startX + sigColWidth + 20, y, { width: sigColWidth, align: 'center' });

    doc.end();

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur PDF', detail: err.message });
  }
}

module.exports = { writeBatchPdf };
