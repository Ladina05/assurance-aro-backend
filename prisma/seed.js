const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const data = [
    {
      quartier: "Analakely",
      localisation: "Rue A",
      loue: false,
      codeImmeuble: "IM001",
      nomPropriete: "Propriété A",
      rg: "1345664",
      typeBien: "placement",
      province: "Antananarivo",
      adresse: "Rue A, Analakely",
      sousCompteurs: {
        create: [
          { numeroCompteur: "C001-1", numeroFacture: "F001", montant: 12000 },
          { numeroCompteur: "C001-2", numeroFacture: "F002", montant: 8000 }
        ]
      }
    },
    {
      quartier: "Isoraka",
      localisation: "Avenue B",
      loue: true,
      codeImmeuble: "IM002",
      nomPropriete: "Propriété B",
      rg: "19874564",
      typeBien: "exploitation",
      province: "Antananarivo",
      adresse: "Avenue B, Isoraka",
      sousCompteurs: {
        create: [
          { numeroCompteur: "C002-1", numeroFacture: "F003", montant: 9000 }
        ]
      }
    }
  ];

  for (const c of data) {
    await prisma.compteur.create({
      data: c
    });
  }

  console.log("✅ Seed terminé avec succès !");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
