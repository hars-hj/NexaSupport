import { Request, Response } from 'express';
import { supabaseAnon, supabaseAdmin } from '../lib/supabaseClient.js';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';

// export async function register(req: Request, res: Response) {
//   const { email, password, name } = req.body;

//   if (!email || !password) {
//     return res.status(400).json({ error: 'Email and password are required' });
//   }

//   const { data, error } = await supabaseAnon.auth.signUp({ email, password });

//   if (error) return res.status(400).json({ error: error.message });

//   return res.status(201).json({
//     message: 'Registration successful. Check your email to confirm.',
//     userId: data.user?.id,
//   });
// }

import { randomUUID } from 'crypto';

export async function registerAdmin(req: Request, res: Response) {
  const { email, password, organizationName } = req.body;

  if (!email || !password || !organizationName) {
    return res.status(400).json({ error: 'Email, password, and organization name are required' });
  }

  // 1. Create the organization
  const widgetKey = `wk_live_${randomUUID()}`;

  const { data: org, error: orgError } = await supabaseAdmin
    .from('organizations')
    .insert({
      name: organizationName,
      widget_key: widgetKey,
      plan: 'free', // default plan on signup
    })
    .select()
    .single();

  if (orgError) return res.status(500).json({ error: 'Failed to create organization' });

  // 2. Create user in Supabase Auth
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
  });

  if (error) {
    // Roll back the organization since the user creation failed
    await supabaseAdmin.from('organizations').delete().eq('id', org.id);
    return res.status(400).json({ error: error.message });
  }

  // 3. Set role to admin in profiles table
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({
    role: 'admin',
    email,
    })
    .eq('id', data.user.id);

  if (profileError) {
    await supabaseAdmin.from('organizations').delete().eq('id', org.id);
    return res.status(500).json({ error: 'Failed to set admin role' });
  }

  // 4. Add user as an admin member of the organization
  const { error: memberError } = await supabaseAdmin
    .from('organization_members')
    .insert({
      org_id: org.id,
      user_id: data.user.id,
      role: 'admin',
    });

  if (memberError) {
    await supabaseAdmin.from('organizations').delete().eq('id', org.id);
    return res.status(500).json({ error: 'Failed to create organization membership' });
  }

  return res.status(201).json({
    message: 'Admin account and organization created successfully',
    userId: data.user.id,
    organizationId: org.id,
    widgetKey,
  });
}

export async function login(req: Request, res: Response) {
  // console.log(req.body);
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });

  if (error) return res.status(401).json({ error: error.message });

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .single();

  if (profileError || !profile) {
    return res.status(500).json({ error: 'Failed to load user profile' });
  }

  return res.status(200).json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    user: {
      id: data.user.id,
      email: data.user.email ?? '',
      role:  (profile.role as 'user' | 'admin' | 'agent') ?? 'user',
    },
  });
}

export async function getMe(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return res.status(200).json({ user: req.user });
}

export async function refreshToken(req: Request, res: Response) {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token is required' });
  }

  const { data, error } = await supabaseAnon.auth.refreshSession({
    refresh_token: refreshToken,
  });

  if (error) return res.status(401).json({ error: error.message });

  return res.status(200).json({
    accessToken: data.session!.access_token,
    refreshToken: data.session!.refresh_token,
  });
}