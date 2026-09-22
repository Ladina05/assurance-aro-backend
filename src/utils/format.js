function formatMontantFR(montant) {
  if (montant == null) return '-';
  return montant.toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true
  }).replace(/\u202F/g, ' ') + ' Ar';
}

function montantEnLettres(montant) {
  const chiffres = [
    '', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
    'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
    'dix-sept', 'dix-huit', 'dix-neuf'
  ];
  const dizaines = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];

  function convertirNombre(n) {
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
          texte += ' ';
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

module.exports = { formatMontantFR, montantEnLettres };
