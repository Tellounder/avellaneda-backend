import { AdminRole, AuthUserStatus, AuthUserType } from '@prisma/client';
import prisma from '../../prisma/client';

export type AuthContext = {
  uid: string;
  email: string;
  authUserId: string;
  userType: AuthUserType;
  status: AuthUserStatus;
  shopId?: string;
  adminRole?: AdminRole;
};

const normalizeEmail = (value?: string | null) => (value || '').trim().toLowerCase();

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);

export const resolveAuthContext = async (uid: string, email: string): Promise<AuthContext> => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error('Email requerido para autenticar.');
  }

  const isAdmin = ADMIN_EMAILS.has(normalizedEmail);
  let authUser = await prisma.authUser.findUnique({ where: { email: normalizedEmail } });

  if (!authUser) {
    authUser = await prisma.authUser.create({
      data: {
        email: normalizedEmail,
        passwordHash: null,
        userType: isAdmin ? AuthUserType.ADMIN : AuthUserType.CLIENT,
        status: AuthUserStatus.ACTIVE,
      },
    });
  }

  if (isAdmin && authUser.userType !== AuthUserType.ADMIN) {
    authUser = await prisma.authUser.update({
      where: { id: authUser.id },
      data: { userType: AuthUserType.ADMIN },
    });
  }

  if (authUser.userType === AuthUserType.ADMIN) {
    const admin = await prisma.admin.upsert({
      where: { authUserId: authUser.id },
      update: { role: AdminRole.SUPERADMIN },
      create: { authUserId: authUser.id, role: AdminRole.SUPERADMIN },
    });

    return {
      uid,
      email: normalizedEmail,
      authUserId: authUser.id,
      userType: AuthUserType.ADMIN,
      status: authUser.status,
      adminRole: admin.role,
    };
  }

  const shop = await prisma.shop.findFirst({
    where: { authUserId: authUser.id },
    select: { id: true },
  });

  if (shop) {
    if (authUser.userType !== AuthUserType.SHOP) {
      await prisma.authUser.update({
        where: { id: authUser.id },
        data: { userType: AuthUserType.SHOP },
      });
    }
    return {
      uid,
      email: normalizedEmail,
      authUserId: authUser.id,
      userType: AuthUserType.SHOP,
      status: authUser.status,
      shopId: shop.id,
    };
  }

  const emailLinkedShop = await prisma.shop.findFirst({
    where: {
      email: {
        equals: normalizedEmail,
        mode: 'insensitive',
      },
    },
    select: { id: true, authUserId: true, requiresEmailFix: true },
  });
  if (emailLinkedShop) {
    await prisma.$transaction(async (tx) => {
      if (emailLinkedShop.authUserId !== authUser.id || emailLinkedShop.requiresEmailFix) {
        await tx.shop.update({
          where: { id: emailLinkedShop.id },
          data: { authUserId: authUser.id, requiresEmailFix: false },
        });
      }
      await tx.authUser.update({
        where: { id: authUser.id },
        data: { userType: AuthUserType.SHOP },
      });
    });
    return {
      uid,
      email: normalizedEmail,
      authUserId: authUser.id,
      userType: AuthUserType.SHOP,
      status: authUser.status,
      shopId: emailLinkedShop.id,
    };
  }

  await prisma.client.upsert({
    where: { authUserId: authUser.id },
    update: {},
    create: { authUserId: authUser.id },
  });

  if (authUser.userType !== AuthUserType.CLIENT) {
    await prisma.authUser.update({
      where: { id: authUser.id },
      data: { userType: AuthUserType.CLIENT },
    });
  }

  return {
    uid,
    email: normalizedEmail,
    authUserId: authUser.id,
    userType: AuthUserType.CLIENT,
    status: authUser.status,
  };
};
