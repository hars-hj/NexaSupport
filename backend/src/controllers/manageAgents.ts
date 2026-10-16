import { Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabaseClient.js';
import {AuthenticatedRequest} from '../middleware/auth.middleware.js';

async function getOrgIdForAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('org_id')
    .eq('user_id', userId)
    .eq('role', 'admin')
    .single();

  if (error || !data) return null;
  return data.org_id as string;
}

export async function createAgent(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
   
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const orgId = await getOrgIdForAdmin(req.user.id);
  if (!orgId) {
    return res.status(403).json({ error: 'No organization found for this admin' });
  }

  // 1. Create user in Supabase Auth
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  const userId = data.user.id;
  console.log("Created new agent user with ID:", userId);

  // 2. Set role to agent in profiles table
  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({
      role: 'agent',
      email,
    })
    .eq('id', userId);

    

  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    return res.status(500).json({ error: 'Failed to set agent role' });
  }

  // 3. Add user as an agent member of the admin's organization
  const { data: memberData,error: memberError } = await supabaseAdmin
    .from('organization_members')
    .insert({
      org_id: orgId,
      user_id: userId,
      role: 'agent',
    });
 console.log("Inserted new agent into organization_members:", memberData);
  if (memberError) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    return res.status(500).json({ error: 'Failed to create organization membership' });
  }

  return res.status(201).json({
    id: userId,
    email: data.user.email ?? email,
    created_at: data.user.created_at,
  });
}

export async function getAgents(req: AuthenticatedRequest, res: Response) {
 
  if (!req.user) {
 
    return res.status(401).json({ error: 'Authentication required' });
  }

  const orgId = await getOrgIdForAdmin(req.user.id);
  if (!orgId) {
    return res.status(403).json({ error: 'No organization found for this admin' });
  }

  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select(`
      user_id,
      created_at
    `)
    .eq('org_id', orgId)
    

  if (error) {
    console.error("Error fetching agents:", error);
    return res.status(500).json({ error: 'Failed to load agents' });
  }

const agents = await Promise.all(
  (data ?? []).map(async (row: any) => {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('email')
      .eq('id', row.user_id)
      .single();

    if (error) {
      console.error(`Failed to fetch profile for ${row.user_id}:`, error);
    }

    return {
      id: row.user_id,
      email: profile?.email ?? '',
      created_at: row.created_at,
    };
  })
);



  return res.status(200).json(agents);
}

export async function deleteAgent(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Agent id is required' });
  }

  const orgId = await getOrgIdForAdmin(req.user.id);
  if (!orgId) {
    return res.status(403).json({ error: 'No organization found for this admin' });
  }

  // Confirm the target is actually an agent in this org before touching anything —
  // prevents deleting a member of a different org or an admin via this endpoint.
  const { data: member, error: memberFetchError } = await supabaseAdmin
    .from('organization_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .eq('user_id', id)
    .single();

  if (memberFetchError || !member) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  if (member.role !== 'agent') {
    return res.status(400).json({ error: 'Only agent accounts can be removed this way' });
  }

  const { error: memberDeleteError } = await supabaseAdmin
    .from('organization_members')
    .delete()
    .eq('org_id', orgId)
    .eq('user_id', id);

  if (memberDeleteError) {
    return res.status(500).json({ error: 'Failed to remove agent from organization' });
  }

  const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (authDeleteError) {
    return res.status(500).json({ error: 'Failed to delete agent account' });
  }

  return res.status(200).json({ message: 'Agent removed successfully' });
}