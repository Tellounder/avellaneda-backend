import { AdminRole, AuthRole, AuthUserStatus, AuthUserType } from '@prisma/client';
import prisma from './repo';
import { firebaseAuth } from '../../lib/firebaseAdmin';
import { resolveAppUrl, sendEmailTemplate } from '../../services/email.service';
import {
  buildEmailVerificationEmailTemplate,
  buildForgotPasswordEmailTemplate,
} from '../../services/emailTemplates';

export type AuthContext = {
  uid: string;
  email: string;
  authUserId: string;
  userType: AuthUserType;
  role: AuthRole;
  status: AuthUserStatus;
  shopId?: string;
  adminRole?: AdminRole;
  requiresOnboarding?: boolean;
};

export type OnboardingIntent = 'USER' | 'STORE';

const normalizeEmail = (value?: string | null) => (value || '').trim().toLowerCase();
const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const includesText = (value: unknown, text: string) =>
  String(value || '')
    .toLowerCase()
    .includes(text.toLowerCase());
const isFirebaseUserNotFound = (error: any) =>
  error?.code === 'auth/user-not-found' ||
  includesText(error?.message, 'no user record corresponding') ||
  includesText(error?.errorInfo?.message, 'no user record corresponding');
const isFirebaseResetLinkUnavailable = (error: any) =>
  error?.code === 'auth/internal-error' &&
  (includesText(error?.message, 'unable to create the email action link') ||
    includesText(error?.errorInfo?.message, 'unable to create the email action link'));
const buildResetContinueUrl = (intent: 'forgot_password') => {
  const baseUrl = resolveAppUrl().trim().replace(/\/+$/g, '');
  const continueUrl = new URL(`${baseUrl}/reset`);
  continueUrl.searchParams.set('intent', intent);
  return continueUrl.toString();
};

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);

const toAuthRoleFromAdmin = (adminRole: AdminRole | undefined | null): AuthRole =>
  adminRole === AdminRole.SUPERADMIN ? AuthRole.SUPERADMIN : AuthRole.ADMIN;

const buildContext = (input: {
  uid: string;
  email: string;
  authUserId: string;
  userType: AuthUserType;
  role: AuthRole;
  status: AuthUserStatus;
  shopId?: string;
  adminRole?: AdminRole;
}): AuthContext => ({
  ...input,
  requiresOnboarding:
    input.role === AuthRole.UNDEFINED || input.role === AuthRole.PENDING_STORE,
});

const ensureClientProfile = async (authUserId: string) => {
  await prisma.client.upsert({
    where: { authUserId },
    update: {},
    create: { authUserId },
  });
};

const syncAuthUserBase = async (
  authUserId: string,
  patch: Partial<{
    userType: AuthUserType;
    role: AuthRole;
    firebaseUid: string;
  }>
) => {
  const data: Record<string, unknown> = {
    lastLoginAt: new Date(),
  };
  if (patch.userType) data.userType = patch.userType;
  if (patch.role) data.role = patch.role;
  if (patch.firebaseUid) data.firebaseUid = patch.firebaseUid;
  await prisma.authUser.update({
    where: { id: authUserId },
    data,
  });
};

export const resolveAuthContext = async (uid: string, email: string): Promise<AuthContext> => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error('Email requerido para autenticar.');
  }

  const isAdminEmail = ADMIN_EMAILS.has(normalizedEmail);
  let authUser =
    (await prisma.authUser.findUnique({ where: { firebaseUid: uid } })) ||
    (await prisma.authUser.findUnique({ where: { email: normalizedEmail } }));

  if (!authUser) {
    authUser = await prisma.authUser.create({
      data: {
        email: normalizedEmail,
        firebaseUid: uid,
        passwordHash: null,
        userType: isAdminEmail ? AuthUserType.ADMIN : AuthUserType.CLIENT,
        role: isAdminEmail ? AuthRole.SUPERADMIN : AuthRole.UNDEFINED,
        status: AuthUserStatus.ACTIVE,
        lastLoginAt: new Date(),
      },
    });
  } else {
    const patch: Record<string, unknown> = { lastLoginAt: new Date() };
    if (authUser.firebaseUid !== uid) {
      patch.firebaseUid = uid;
    }
    if (Object.keys(patch).length > 0) {
      authUser = await prisma.authUser.update({
        where: { id: authUser.id },
        data: patch,
      });
    }
  }

  if (isAdminEmail || authUser.userType === AuthUserType.ADMIN) {
    const adminTargetRole = isAdminEmail ? AdminRole.SUPERADMIN : AdminRole.MODERATOR;
    const admin = await prisma.admin.upsert({
      where: { authUserId: authUser.id },
      update: isAdminEmail ? { role: AdminRole.SUPERADMIN } : {},
      create: { authUserId: authUser.id, role: adminTargetRole },
    });
    const role = toAuthRoleFromAdmin(admin.role);
    await syncAuthUserBase(authUser.id, {
      userType: AuthUserType.ADMIN,
      role,
      firebaseUid: uid,
    });
    return buildContext({
      uid,
      email: normalizedEmail,
      authUserId: authUser.id,
      userType: AuthUserType.ADMIN,
      role,
      status: authUser.status,
      adminRole: admin.role,
    });
  }

  const linkedShopByOwner = await prisma.shop.findFirst({
    where: { authUserId: authUser.id },
    select: { id: true },
  });

  if (linkedShopByOwner) {
    await syncAuthUserBase(authUser.id, {
      userType: AuthUserType.SHOP,
      role: AuthRole.STORE,
      firebaseUid: uid,
    });
    return buildContext({
      uid,
      email: normalizedEmail,
      authUserId: authUser.id,
      userType: AuthUserType.SHOP,
      role: AuthRole.STORE,
      status: authUser.status,
      shopId: linkedShopByOwner.id,
    });
  }

  const linkedShopByEmail = await prisma.shop.findFirst({
    where: {
      OR: [
        {
          email: {
            equals: normalizedEmail,
            mode: 'insensitive',
          },
        },
        {
          contactEmailPrivate: {
            equals: normalizedEmail,
            mode: 'insensitive',
          },
        },
      ],
    },
    select: { id: true, authUserId: true, requiresEmailFix: true, email: true },
  });

  if (linkedShopByEmail) {
    await prisma.$transaction(async (tx) => {
      if (
        linkedShopByEmail.authUserId !== authUser.id ||
        linkedShopByEmail.requiresEmailFix ||
        !normalizeEmail(linkedShopByEmail.email)
      ) {
        await tx.shop.update({
          where: { id: linkedShopByEmail.id },
          data: {
            authUserId: authUser.id,
            requiresEmailFix: false,
            ...(normalizeEmail(linkedShopByEmail.email) ? {} : { email: normalizedEmail }),
          },
        });
      }
      await tx.authUser.update({
        where: { id: authUser.id },
        data: {
          userType: AuthUserType.SHOP,
          role: AuthRole.STORE,
          firebaseUid: uid,
          lastLoginAt: new Date(),
        },
      });
    });
    return buildContext({
      uid,
      email: normalizedEmail,
      authUserId: authUser.id,
      userType: AuthUserType.SHOP,
      role: AuthRole.STORE,
      status: authUser.status,
      shopId: linkedShopByEmail.id,
    });
  }

  const hasClientProfile = Boolean(
    await prisma.client.findUnique({
      where: { authUserId: authUser.id },
      select: { authUserId: true },
    })
  );

  let role = authUser.role;
  if (role === AuthRole.SUPERADMIN || role === AuthRole.ADMIN) {
    role = AuthRole.USER;
  } else if (role === AuthRole.STORE) {
    role = AuthRole.PENDING_STORE;
  } else if (role === AuthRole.UNDEFINED && hasClientProfile) {
    role = AuthRole.USER;
  }

  if (role === AuthRole.USER && !hasClientProfile) {
    await ensureClientProfile(authUser.id);
  }

  await syncAuthUserBase(authUser.id, {
    userType: AuthUserType.CLIENT,
    role,
    firebaseUid: uid,
  });

  return buildContext({
    uid,
    email: normalizedEmail,
    authUserId: authUser.id,
    userType: AuthUserType.CLIENT,
    role,
    status: authUser.status,
  });
};

export const completeOnboardingIntent = async (
  params: { authUserId: string; uid: string; email: string },
  intent: OnboardingIntent
) => {
  const normalizedIntent = String(intent || '').trim().toUpperCase();
  if (normalizedIntent !== 'USER' && normalizedIntent !== 'STORE') {
    throw { status: 400, message: 'Intent invalido.' };
  }

  const normalizedEmail = normalizeEmail(params.email);
  if (!normalizedEmail) {
    throw { status: 400, message: 'Email requerido.' };
  }

  await prisma.$transaction(async (tx) => {
    const authUser = await tx.authUser.findUnique({
      where: { id: params.authUserId },
      select: { id: true, userType: true, role: true },
    });
    if (!authUser) {
      throw { status: 404, message: 'Usuario no encontrado.' };
    }

    if (normalizedIntent === 'USER') {
      await tx.authUser.update({
        where: { id: authUser.id },
        data: {
          userType: AuthUserType.CLIENT,
          role: AuthRole.USER,
          onboardingCompletedAt: new Date(),
          firebaseUid: params.uid,
          lastLoginAt: new Date(),
        },
      });
      await tx.client.upsert({
        where: { authUserId: authUser.id },
        update: {},
        create: { authUserId: authUser.id },
      });
      return;
    }

    const linkedShop = await tx.shop.findFirst({
      where: { authUserId: authUser.id },
      select: { id: true },
    });
    await tx.authUser.update({
      where: { id: authUser.id },
      data: {
        userType: linkedShop ? AuthUserType.SHOP : AuthUserType.CLIENT,
        role: linkedShop ? AuthRole.STORE : AuthRole.PENDING_STORE,
        onboardingCompletedAt: new Date(),
        firebaseUid: params.uid,
        lastLoginAt: new Date(),
      },
    });
  });

  return resolveAuthContext(params.uid, normalizedEmail);
};

export const listAuthUsersAdmin = async (limitInput?: number) => {
  const limit = Math.min(Math.max(Number(limitInput || 200), 1), 1000);
  const users = await prisma.authUser.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      firebaseUid: true,
      userType: true,
      role: true,
      status: true,
      createdAt: true,
      lastLoginAt: true,
      onboardingCompletedAt: true,
      admin: {
        select: {
          role: true,
          adminStatus: true,
        },
      },
      client: {
        select: {
          displayName: true,
          profileCompletedAt: true,
          city: true,
          province: true,
        },
      },
      shop: {
        select: {
          id: true,
          name: true,
          status: true,
          registrationSource: true,
        },
      },
    },
  });

  return users.map((user) => ({
    id: user.id,
    email: user.email,
    firebaseUid: user.firebaseUid,
    userType: user.userType,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    onboardingCompletedAt: user.onboardingCompletedAt,
    adminRole: user.admin?.role || null,
    adminStatus: user.admin?.adminStatus || null,
    displayName: user.client?.displayName || null,
    profileCompletedAt: user.client?.profileCompletedAt || null,
    city: user.client?.city || null,
    province: user.client?.province || null,
    shopId: user.shop?.id || null,
    shopName: user.shop?.name || null,
    shopStatus: user.shop?.status || null,
    shopSource: user.shop?.registrationSource || null,
  }));
};

export const requestPasswordReset = async (inputEmail: string) => {
  const email = normalizeEmail(inputEmail);
  if (!email || !isValidEmail(email)) {
    throw { status: 400, message: 'Email invalido.' };
  }
  if (!firebaseAuth) {
    throw new Error('Firebase Admin no configurado.');
  }

  try {
    await firebaseAuth.getUserByEmail(email);
  } catch (error: any) {
    if (isFirebaseUserNotFound(error) || isFirebaseResetLinkUnavailable(error)) {
      return { ok: true };
    }
    throw error;
  }

  let resetUrl: string | null = null;
  try {
    resetUrl = await firebaseAuth.generatePasswordResetLink(email, {
      url: buildResetContinueUrl('forgot_password'),
      handleCodeInApp: false,
    });
  } catch (error: any) {
    if (isFirebaseResetLinkUnavailable(error)) {
      return { ok: true };
    }
    throw error;
  }

  if (resetUrl) {
    const template = buildForgotPasswordEmailTemplate({
      resetUrl,
      appUrl: resolveAppUrl(),
    });
    await sendEmailTemplate(email, template, { requireConfigured: true });
  }

  return { ok: true };
};

export const requestEmailVerification = async (inputEmail: string) => {
  const email = normalizeEmail(inputEmail);
  if (!email || !isValidEmail(email)) {
    throw { status: 400, message: 'Email invalido.' };
  }
  if (!firebaseAuth) {
    throw new Error('Firebase Admin no configurado.');
  }

  let verifyUrl: string | null = null;
  try {
    verifyUrl = await firebaseAuth.generateEmailVerificationLink(email);
  } catch (error: any) {
    if (error?.code !== 'auth/user-not-found') {
      throw error;
    }
  }

  if (verifyUrl) {
    const template = buildEmailVerificationEmailTemplate({
      verifyUrl,
      appUrl: resolveAppUrl(),
    });
    await sendEmailTemplate(email, template, { requireConfigured: true });
  }

  return { ok: true };
};
