const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../prismaClient');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key';
const PASSWORD_RESET_EXPIRY = parseInt(process.env.PASSWORD_RESET_TOKEN_EXPIRY) || 3600000;

// Configuration email - CORRECTION: createTransport au lieu de createTransporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ✅ Inscription avec approbation
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ message: 'Email déjà utilisé' });

    const hashedPassword = await bcrypt.hash(password, 10);

    // Créer l'utilisateur avec statut en attente
    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: 'PENDING',
        isActive: false
      },
    });

    // Envoyer email à l'admin pour approbation
    await sendApprovalEmailToAdmin(newUser);

    res.status(201).json({
      message: 'Inscription réussie ! Votre compte est en attente d\'approbation par l\'administrateur.',
      user: { id: newUser.id, name: newUser.name, email: newUser.email }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', detail: err.message });
  }
});

// ✅ Connexion (seulement pour les utilisateurs actifs)
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });

    // Vérifier si le compte est actif
    if (!user.isActive) {
      return res.status(401).json({
        message: 'Votre compte est en attente d\'approbation par l\'administrateur.'
      });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: 'Mot de passe incorrect' });

    const token = jwt.sign({
      userId: user.id,
      role: user.role
    }, JWT_SECRET, { expiresIn: '1d' });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', detail: err.message });
  }
});

// ✅ Route pour l'admin pour approuver les utilisateurs
router.post('/approve-user', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'Non autorisé' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Vérifier si l'utilisateur est admin
    const adminUser = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!adminUser || adminUser.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Accès refusé. Admin uniquement.' });
    }

    const { userId, role } = req.body;

    if (!['INSERTEUR', 'CLIENT'].includes(role)) {
      return res.status(400).json({ message: 'Rôle invalide' });
    }

    // Mettre à jour l'utilisateur
    const updatedUser = await prisma.user.update({
      where: { id: parseInt(userId) },
      data: {
        role: role,
        isActive: true
      }
    });

    // Envoyer un email de confirmation à l'utilisateur
    await sendApprovalConfirmationEmail(updatedUser);

    res.json({
      message: `Utilisateur approuvé avec succès en tant que ${role}`,
      user: updatedUser
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', detail: err.message });
  }
});

// ✅ Route pour récupérer les utilisateurs en attente (admin seulement)
router.get('/pending-users', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'Non autorisé' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Vérifier si l'utilisateur est admin
    const adminUser = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!adminUser || adminUser.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Accès refusé. Admin uniquement.' });
    }

    const pendingUsers = await prisma.user.findMany({
      where: {
        isActive: false,
        role: 'PENDING'
      },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true
      }
    });

    res.json(pendingUsers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', detail: err.message });
  }
});

// ✅ Route simple pour approuver via lien email (sans authentification)
router.get('/approve-user', async (req, res) => {
  try {
    const { userId, role } = req.query;

    if (!userId || !role || !['INSERTEUR', 'CLIENT'].includes(role)) {
      return res.status(400).json({ message: 'Paramètres invalides' });
    }

    // Mettre à jour l'utilisateur
    const updatedUser = await prisma.user.update({
      where: { id: parseInt(userId) },
      data: {
        role: role,
        isActive: true
      }
    });

    // Envoyer un email de confirmation à l'utilisateur
    await sendApprovalConfirmationEmail(updatedUser);

    res.send(`
      <html>
        <head>
          <title>Utilisateur Approuvé</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            .success { color: #28a745; }
            .info { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <h1 class="success">✅ Utilisateur Approuvé</h1>
          <div class="info">
            <p><strong>Nom:</strong> ${updatedUser.name}</p>
            <p><strong>Email:</strong> ${updatedUser.email}</p>
            <p><strong>Rôle:</strong> ${updatedUser.role}</p>
          </div>
          <p>L'utilisateur a été notifié par email et peut maintenant se connecter.</p>
          <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}">Retour à l'application</a>
        </body>
      </html>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send(`
      <html>
        <body>
          <h1 style="color: red;">Erreur</h1>
          <p>Une erreur est survenue lors de l'approbation.</p>
          <p>${err.message}</p>
        </body>
      </html>
    `);
  }
});

// ✅ Profil (protégé)
router.get('/profile', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'Non autorisé' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true
      },
    });

    res.json(user);
  } catch (err) {
    res.status(401).json({ message: 'Token invalide' });
  }
});

// ✅ Changer mot de passe
router.put('/change-password', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'Non autorisé' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword || !newPassword)
      return res.status(400).json({ message: 'Champs manquants' });

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(404).json({ message: 'Utilisateur non trouvé' });

    const valid = await bcrypt.compare(oldPassword, user.password);
    if (!valid) return res.status(401).json({ message: 'Ancien mot de passe incorrect' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    res.json({ message: 'Mot de passe changé avec succès' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur serveur', detail: err.message });
  }
});

// Fonction pour envoyer l'email d'approbation à l'admin
async function sendApprovalEmailToAdmin(user) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_USER;

  const approvalUrl = `${process.env.API_URL || 'http://localhost:4000/api'}/auth/approve-user`;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: adminEmail,
    subject: 'Nouvelle inscription nécessitant votre approbation - ARO IMMO',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Nouvelle inscription nécessitant votre approbation</h2>
        
        <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Nom:</strong> ${user.name}</p>
          <p><strong>Email:</strong> ${user.email}</p>
          <p><strong>Date d'inscription:</strong> ${new Date(user.createdAt).toLocaleDateString('fr-FR')}</p>
        </div>

        <p>Veuillez choisir le rôle pour cet utilisateur en cliquant sur l'un des liens ci-dessous :</p>
        
        <div style="margin: 20px 0;">
          <a href="${approvalUrl}?userId=${user.id}&role=INSERTEUR" 
             style="background: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-right: 10px; display: inline-block;">
            ✅ Approuver comme Inserteur
          </a>
          
          <a href="${approvalUrl}?userId=${user.id}&role=CLIENT" 
             style="background: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
            👥 Approuver comme Client
          </a>
        </div>

        <p><em>Les liens ci-dessus approuveront immédiatement l'utilisateur avec le rôle sélectionné.</em></p>
        
        <hr style="margin: 30px 0;">
        <p style="color: #666; font-size: 12px;">
          Cet email a été envoyé automatiquement depuis votre application ARO IMMO.
        </p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('✅ Email d\'approbation envoyé à l\'admin');
  } catch (error) {
    console.error('❌ Erreur lors de l\'envoi de l\'email à l\'admin:', error);
  }
}

// Fonction pour envoyer l'email de confirmation à l'utilisateur
async function sendApprovalConfirmationEmail(user) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: user.email,
    subject: 'Votre compte a été approuvé - ARO IMMO',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #28a745;">Félicitations ! Votre compte a été approuvé</h2>
        
        <p>Bonjour <strong>${user.name}</strong>,</p>
        
        <p>Votre compte ARO IMMO a été approuvé par l'administrateur.</p>
        
        <div style="background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Rôle attribué:</strong> ${user.role}</p>
          <p><strong>Statut:</strong> Actif</p>
        </div>

        <p>Vous pouvez maintenant vous connecter à votre compte et accéder à l'application.</p>
        
        <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/login" 
           style="background: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 20px;">
          🔐 Se connecter à l'application
        </a>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log('✅ Email de confirmation envoyé à l\'utilisateur');
  } catch (error) {
    console.error('❌ Erreur lors de l\'envoi de l\'email de confirmation:', error);
  }
}

// ✅ Demande de réinitialisation de mot de passe - CORRECTION
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email requis' });
    }

    // Chercher l'utilisateur
    const user = await prisma.user.findUnique({
      where: { email }
    });

    // Ne pas révéler si l'email existe ou non pour des raisons de sécurité
    if (!user) {
      return res.json({
        message: 'Si un compte avec cet email existe, un lien de réinitialisation a été envoyé.'
      });
    }

    // Vérifier si l'utilisateur est actif
    if (!user.isActive) {
      return res.status(400).json({
        message: 'Votre compte est en attente d\'approbation. Contactez l\'administrateur.'
      });
    }

    // CORRECTION : Utiliser crypto correctement
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    // Date d'expiration (1 heure)
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY);

    // Supprimer les anciens tokens de réinitialisation
    await prisma.passwordResetToken.deleteMany({
      where: { userId: user.id }
    });

    // Créer le nouveau token
    await prisma.passwordResetToken.create({
      data: {
        token: hashedToken,
        userId: user.id,
        expiresAt: expiresAt
      }
    });

    // Envoyer l'email de réinitialisation
    await sendPasswordResetEmail(user, resetToken);

    res.json({
      message: 'Si un compte avec cet email existe, un lien de réinitialisation a été envoyé.'
    });

  } catch (err) {
    console.error('Erreur demande réinitialisation mot de passe:', err);
    res.status(500).json({ message: 'Erreur serveur', detail: err.message });
  }
});

// ✅ Réinitialisation du mot de passe - CORRECTION
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ message: 'Token et nouveau mot de passe requis' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    // CORRECTION : Hasher le token pour la comparaison
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Chercher le token de réinitialisation
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { token: hashedToken },
      include: { user: true }
    });

    // Vérifications
    if (!resetToken) {
      return res.status(400).json({ message: 'Token invalide ou expiré' });
    }

    if (resetToken.used) {
      return res.status(400).json({ message: 'Ce token a déjà été utilisé' });
    }

    if (new Date() > resetToken.expiresAt) {
      return res.status(400).json({ message: 'Token expiré' });
    }

    if (!resetToken.user.isActive) {
      return res.status(400).json({ message: 'Compte inactif' });
    }

    // Hasher le nouveau mot de passe
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Mettre à jour le mot de passe de l'utilisateur
    await prisma.$transaction(async (tx) => {
      // Mettre à jour le mot de passe
      await tx.user.update({
        where: { id: resetToken.userId },
        data: { password: hashedPassword }
      });

      // Marquer le token comme utilisé
      await tx.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { used: true }
      });

      // Supprimer tous les autres tokens de l'utilisateur
      await tx.passwordResetToken.deleteMany({
        where: {
          userId: resetToken.userId,
          id: { not: resetToken.id }
        }
      });
    });

    // Envoyer un email de confirmation
    await sendPasswordResetConfirmationEmail(resetToken.user);

    res.json({ message: 'Mot de passe réinitialisé avec succès' });

  } catch (err) {
    console.error('Erreur réinitialisation mot de passe:', err);
    res.status(500).json({ message: 'Erreur serveur', detail: err.message });
  }
});

// ✅ Vérification de la validité d'un token - CORRECTION
router.get('/verify-reset-token/:token', async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({ message: 'Token requis' });
    }

    // CORRECTION : Hasher le token pour la comparaison
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Chercher le token de réinitialisation
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { token: hashedToken },
      include: { user: true }
    });

    // Vérifications
    if (!resetToken) {
      return res.status(400).json({ valid: false, message: 'Token invalide' });
    }

    if (resetToken.used) {
      return res.status(400).json({ valid: false, message: 'Token déjà utilisé' });
    }

    if (new Date() > resetToken.expiresAt) {
      return res.status(400).json({ valid: false, message: 'Token expiré' });
    }

    if (!resetToken.user.isActive) {
      return res.status(400).json({ valid: false, message: 'Compte inactif' });
    }

    res.json({
      valid: true,
      message: 'Token valide',
      email: resetToken.user.email
    });

  } catch (err) {
    console.error('Erreur vérification token:', err);
    res.status(500).json({ valid: false, message: 'Erreur serveur', detail: err.message });
  }
});

// Fonction pour envoyer l'email de réinitialisation de mot de passe
async function sendPasswordResetEmail(user, resetToken) {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: user.email,
    subject: 'Réinitialisation de votre mot de passe - ARO IMMO',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Réinitialisation de mot de passe</h2>
        
        <p>Bonjour <strong>${user.name}</strong>,</p>
        
        <p>Vous avez demandé la réinitialisation de votre mot de passe ARO IMMO.</p>
        
        <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; border: 1px solid #ffeaa7;">
          <p style="margin: 0; color: #856404;">
            <strong>⚠️ Important:</strong> Ce lien expirera dans 1 heure.
          </p>
        </div>

        <p>Cliquez sur le bouton ci-dessous pour réinitialiser votre mot de passe :</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" 
             style="background: #007bff; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: bold; display: inline-block;">
            🔐 Réinitialiser mon mot de passe
          </a>
        </div>

        <p style="color: #666; font-size: 14px;">
          Si vous n'avez pas demandé cette réinitialisation, veuillez ignorer cet email.
        </p>

        <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin-top: 20px;">
          <p style="margin: 0; color: #6c757d; font-size: 12px;">
            <strong>Lien de secours:</strong> Si le bouton ne fonctionne pas, copiez-collez ce lien dans votre navigateur :<br>
            ${resetUrl}
          </p>
        </div>

        <hr style="margin: 30px 0;">
        <p style="color: #666; font-size: 12px;">
          Cet email a été envoyé automatiquement depuis l'application ARO IMMO.
        </p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Email de réinitialisation envoyé à ${user.email}`);
  } catch (error) {
    console.error('❌ Erreur envoi email réinitialisation:', error);
    throw error;
  }
}

// Fonction pour envoyer l'email de confirmation de réinitialisation
async function sendPasswordResetConfirmationEmail(user) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: user.email,
    subject: 'Mot de passe modifié - ARO IMMO',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #28a745;">✅ Mot de passe modifié avec succès</h2>
        
        <p>Bonjour <strong>${user.name}</strong>,</p>
        
        <p>Votre mot de passe ARO IMMO a été réinitialisé avec succès.</p>
        
        <div style="background: #d4edda; padding: 15px; border-radius: 5px; margin: 20px 0; border: 1px solid #c3e6cb;">
          <p style="margin: 0; color: #155724;">
            <strong>🔒 Sécurité:</strong> Si vous n'êtes pas à l'origine de cette modification, 
            veuillez contacter immédiatement l'administrateur.
          </p>
        </div>

        <p>Vous pouvez maintenant vous connecter avec votre nouveau mot de passe :</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${process.env.FRONTEND_URL}/login" 
             style="background: #28a745; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: bold; display: inline-block;">
            🚀 Se connecter
          </a>
        </div>

        <hr style="margin: 30px 0;">
        <p style="color: #666; font-size: 12px;">
          Cet email a été envoyé automatiquement depuis l'application ARO IMMO.
        </p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Email de confirmation envoyé à ${user.email}`);
  } catch (error) {
    console.error('❌ Erreur envoi email confirmation:', error);
    // Ne pas throw l'erreur ici car le mot de passe a déjà été changé
  }
}

module.exports = router;