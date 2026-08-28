-- 北泽组织架构：Supabase/Postgres 数据模型、RLS、RPC 与 Realtime 配置。
--
-- 安全边界：
--   * anon 没有任何业务表或 RPC 权限；所有访问都要求有效的 auth.uid()。
--   * viewer 只读当前组织的有效节点；owner/editor 可查看回收站。
--   * owner/editor 可直接新增节点；更新必须经过带版本校验的 RPC，硬删除永不授予客户端。
--   * 成员、邀请、软删除/恢复和排序只能通过 SECURITY DEFINER RPC 修改。
--   * SECURITY DEFINER 函数固定空 search_path，并在函数体内重新校验组织角色。
--
-- 运行方式：在一个 Supabase 项目的 SQL Editor 中以项目管理员身份执行本文件。

begin;

create schema if not exists extensions;
create schema if not exists private;

create extension if not exists pgcrypto with schema extensions;

revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;
grant usage on schema private to authenticated;

do $types$
begin
  if not exists (
    select 1
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'org_member_role'
  ) then
    create type public.org_member_role as enum ('owner', 'editor', 'viewer');
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'org_node_type'
  ) then
    create type public.org_node_type as enum ('company', 'department', 'position', 'person');
  end if;
end
$types$;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint organizations_name_length check (
    char_length(btrim(name)) between 1 and 120 and name = btrim(name)
  ),
  constraint organizations_version_positive check (version > 0)
);

create table if not exists public.org_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_email text not null,
  role public.org_member_role not null default 'viewer',
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (organization_id, user_id),
  constraint org_memberships_email_canonical check (
    member_email = lower(btrim(member_email))
    and char_length(member_email) between 3 and 320
    and position('@' in member_email) > 1
  ),
  constraint org_memberships_version_positive check (version > 0)
);

create index if not exists org_memberships_user_idx
  on public.org_memberships (user_id, created_at);
create index if not exists org_memberships_org_role_idx
  on public.org_memberships (organization_id, role);

create table if not exists public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role public.org_member_role not null,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '14 days'),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  constraint org_invitations_email_canonical check (
    email = lower(btrim(email))
    and char_length(email) between 3 and 320
    and position('@' in email) > 1
  ),
  constraint org_invitations_non_owner check (role <> 'owner'),
  constraint org_invitations_expiry_valid check (expires_at > created_at),
  constraint org_invitations_acceptance_complete check (
    (accepted_at is null and accepted_by is null)
    or (accepted_at is not null and accepted_by is not null)
  ),
  constraint org_invitations_revocation_complete check (
    (revoked_at is null and revoked_by is null)
    or (revoked_at is not null and revoked_by is not null)
  ),
  constraint org_invitations_single_terminal_state check (
    not (accepted_at is not null and revoked_at is not null)
  )
);

create unique index if not exists org_invitations_one_pending_email_idx
  on public.org_invitations (organization_id, lower(email))
  where accepted_at is null and revoked_at is null;
create index if not exists org_invitations_accept_email_idx
  on public.org_invitations (lower(email), expires_at)
  where accepted_at is null and revoked_at is null;

create table if not exists public.org_nodes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  parent_id uuid,
  type public.org_node_type not null,
  name text not null,
  title text not null default '',
  notes text not null default '',
  sort_order integer not null default 0,
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_batch_id uuid,
  constraint org_nodes_org_id_id_unique unique (organization_id, id),
  constraint org_nodes_parent_same_organization
    foreign key (organization_id, parent_id)
    references public.org_nodes (organization_id, id)
    on delete restrict
    deferrable initially immediate,
  constraint org_nodes_not_self_parent check (parent_id is null or parent_id <> id),
  constraint org_nodes_name_length check (
    char_length(btrim(name)) between 1 and 80 and name = btrim(name)
  ),
  constraint org_nodes_title_length check (char_length(title) <= 120),
  constraint org_nodes_notes_length check (char_length(notes) <= 1000),
  constraint org_nodes_version_positive check (version > 0),
  constraint org_nodes_deletion_state_complete check (
    (deleted_at is null and deleted_by is null and deleted_batch_id is null)
    or (deleted_at is not null and deleted_by is not null and deleted_batch_id is not null)
  )
);

create index if not exists org_nodes_tree_idx
  on public.org_nodes (organization_id, parent_id, sort_order, id)
  where deleted_at is null;
create index if not exists org_nodes_trash_idx
  on public.org_nodes (organization_id, deleted_at desc)
  where deleted_at is not null;
create index if not exists org_nodes_deleted_batch_idx
  on public.org_nodes (organization_id, deleted_batch_id)
  where deleted_batch_id is not null;

create table if not exists public.org_node_deletion_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  root_node_id uuid not null,
  deleted_at timestamptz not null default clock_timestamp(),
  deleted_by uuid not null references auth.users(id) on delete restrict,
  affected_count integer not null default 0,
  restored_at timestamptz,
  restored_by uuid references auth.users(id) on delete set null,
  restore_mutation_id uuid,
  constraint org_node_deletion_batches_org_id_id_unique unique (organization_id, id),
  constraint org_node_deletion_batches_root_same_organization
    foreign key (organization_id, root_node_id)
    references public.org_nodes (organization_id, id)
    on delete restrict,
  constraint org_node_deletion_batches_count_nonnegative check (affected_count >= 0),
  constraint org_node_deletion_batches_restore_complete check (
    (restored_at is null and restored_by is null and restore_mutation_id is null)
    or (restored_at is not null and restored_by is not null and restore_mutation_id is not null)
  )
);

-- Keep re-runs compatible with a project that executed an earlier revision.
alter table public.org_node_deletion_batches
  add column if not exists restore_mutation_id uuid;
alter table public.org_node_deletion_batches
  drop constraint if exists org_node_deletion_batches_restore_complete;
alter table public.org_node_deletion_batches
  add constraint org_node_deletion_batches_restore_complete check (
    (restored_at is null and restored_by is null and restore_mutation_id is null)
    or (restored_at is not null and restored_by is not null and restore_mutation_id is not null)
  );

create unique index if not exists org_node_deletion_batches_restore_mutation_idx
  on public.org_node_deletion_batches (restore_mutation_id)
  where restore_mutation_id is not null;

do $constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'org_nodes_deleted_batch_same_organization'
      and conrelid = 'public.org_nodes'::regclass
  ) then
    alter table public.org_nodes
      add constraint org_nodes_deleted_batch_same_organization
      foreign key (organization_id, deleted_batch_id)
      references public.org_node_deletion_batches (organization_id, id)
      on delete restrict
      deferrable initially deferred;
  end if;
end
$constraint$;

-- Retain a request id even when the root was already deleted by another batch.
-- Retrying that same request after the batch is restored therefore cannot
-- delete the root again.
create table if not exists public.org_node_deletion_requests (
  mutation_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  root_node_id uuid not null,
  batch_id uuid not null,
  requested_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint org_node_deletion_requests_root_same_organization
    foreign key (organization_id, root_node_id)
    references public.org_nodes (organization_id, id)
    on delete restrict,
  constraint org_node_deletion_requests_batch_same_organization
    foreign key (organization_id, batch_id)
    references public.org_node_deletion_batches (organization_id, id)
    on delete restrict
);

create index if not exists org_node_deletion_requests_batch_idx
  on public.org_node_deletion_requests (organization_id, batch_id);

create table if not exists public.org_audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  transaction_id bigint not null default txid_current(),
  created_at timestamptz not null default clock_timestamp(),
  constraint org_audit_log_action_valid check (action in ('insert', 'update', 'delete'))
);

create index if not exists org_audit_log_org_time_idx
  on public.org_audit_log (organization_id, created_at desc, id desc);
create index if not exists org_audit_log_entity_idx
  on public.org_audit_log (organization_id, entity_type, entity_id, created_at desc);

-- RLS policy helper. It bypasses org_memberships RLS only to avoid policy recursion;
-- it returns a role only for the current auth.uid().
create or replace function private.current_org_role(p_organization_id uuid)
returns public.org_member_role
language sql
stable
security definer
set search_path = ''
set row_security = off
as $function$
  select m.role
  from public.org_memberships as m
  where m.organization_id = p_organization_id
    and m.user_id = auth.uid()
  limit 1
$function$;

create or replace function private.require_auth_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;
  return v_user_id;
end
$function$;

create or replace function private.require_org_editor(p_organization_id uuid)
returns public.org_member_role
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_role public.org_member_role;
begin
  perform private.require_auth_user();
  v_role := private.current_org_role(p_organization_id);
  if v_role is null or v_role not in ('owner', 'editor') then
    raise exception using errcode = '42501', message = 'Editor permission required';
  end if;
  return v_role;
end
$function$;

create or replace function private.require_org_owner(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.require_auth_user();
  if private.current_org_role(p_organization_id) is distinct from 'owner'::public.org_member_role then
    raise exception using errcode = '42501', message = 'Owner permission required';
  end if;
end
$function$;

-- Force server-owned metadata and version increments. Direct authenticated
-- updates cannot forge creator/version/deletion metadata.
create or replace function private.prepare_organization_row()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  new.name := btrim(new.name);
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
    if v_user_id is not null then
      new.created_by := v_user_id;
      new.updated_by := v_user_id;
    end if;
  else
    if new.id is distinct from old.id
      or new.created_at is distinct from old.created_at
      or new.created_by is distinct from old.created_by then
      raise exception using errcode = '22000', message = 'Immutable organization fields cannot be changed';
    end if;
    new.version := old.version + 1;
    new.updated_at := clock_timestamp();
    new.updated_by := coalesce(v_user_id, old.updated_by);
  end if;
  return new;
end
$function$;

create or replace function private.prepare_membership_row()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  new.member_email := lower(btrim(new.member_email));
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
    new.created_by := coalesce(v_user_id, new.created_by);
    new.updated_by := coalesce(v_user_id, new.updated_by);
  else
    if new.organization_id is distinct from old.organization_id
      or new.user_id is distinct from old.user_id
      or new.created_at is distinct from old.created_at
      or new.created_by is distinct from old.created_by then
      raise exception using errcode = '22000', message = 'Immutable membership fields cannot be changed';
    end if;
    new.version := old.version + 1;
    new.updated_at := clock_timestamp();
    new.updated_by := coalesce(v_user_id, old.updated_by);
  end if;
  return new;
end
$function$;

create or replace function private.prepare_invitation_row()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.email := lower(btrim(new.email));
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.organization_id is distinct from old.organization_id
      or new.created_at is distinct from old.created_at
      or new.invited_by is distinct from old.invited_by then
      raise exception using errcode = '22000', message = 'Immutable invitation fields cannot be changed';
    end if;
  end if;
  return new;
end
$function$;

create or replace function private.prepare_org_node_row()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_parent_deleted_at timestamptz;
begin
  new.name := btrim(new.name);
  new.title := coalesce(new.title, '');
  new.notes := coalesce(new.notes, '');

  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := clock_timestamp();
    new.updated_at := new.created_at;
    if v_user_id is not null then
      new.created_by := v_user_id;
      new.updated_by := v_user_id;
    end if;

    -- Browser clients may submit a complete locally queued object. Never let
    -- that object manufacture a deleted record or a deletion batch.
    if current_user in ('anon', 'authenticated') then
      new.deleted_at := null;
      new.deleted_by := null;
      new.deleted_batch_id := null;
    end if;
  else
    if new.id is distinct from old.id
      or new.organization_id is distinct from old.organization_id
      or new.created_at is distinct from old.created_at
      or new.created_by is distinct from old.created_by then
      raise exception using errcode = '22000', message = 'Immutable node fields cannot be changed';
    end if;

    if current_user in ('anon', 'authenticated') and (
      new.deleted_at is distinct from old.deleted_at
      or new.deleted_by is distinct from old.deleted_by
      or new.deleted_batch_id is distinct from old.deleted_batch_id
    ) then
      raise exception using errcode = '42501', message = 'Use the recycle-bin RPC to delete or restore nodes';
    end if;

    new.version := old.version + 1;
    new.updated_at := clock_timestamp();
    new.updated_by := coalesce(v_user_id, old.updated_by);
  end if;

  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception using errcode = '23514', message = 'A node cannot be its own parent';
    end if;

    select p.deleted_at
      into v_parent_deleted_at
    from public.org_nodes as p
    where p.organization_id = new.organization_id
      and p.id = new.parent_id;

    if current_user in ('anon', 'authenticated')
      and found
      and new.deleted_at is null
      and v_parent_deleted_at is not null then
      raise exception using errcode = '23514', message = 'An active node cannot be placed below a deleted node';
    end if;

    if exists (
      with recursive ancestors(id, parent_id) as (
        select p.id, p.parent_id
        from public.org_nodes as p
        where p.organization_id = new.organization_id and p.id = new.parent_id
        union
        select p.id, p.parent_id
        from public.org_nodes as p
        join ancestors as a on a.parent_id = p.id
        where p.organization_id = new.organization_id
      )
      select 1 from ancestors where id = new.id
    ) then
      raise exception using errcode = '23514', message = 'The requested parent would create a cycle';
    end if;
  end if;

  return new;
end
$function$;

-- Deferred validation closes races between concurrent parent moves and subtree
-- deletion/restoration. One of two conflicting transactions is rejected at commit.
create or replace function private.validate_org_node_deferred()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.org_nodes as child
    join public.org_nodes as parent
      on parent.organization_id = child.organization_id and parent.id = child.parent_id
    where child.organization_id = new.organization_id
      and child.id = new.id
      and child.deleted_at is null
      and parent.deleted_at is not null
  ) then
    raise exception using errcode = '23514', message = 'An active node cannot have a deleted parent';
  end if;

  if exists (
    select 1
    from public.org_nodes as parent
    join public.org_nodes as child
      on child.organization_id = parent.organization_id and child.parent_id = parent.id
    where parent.organization_id = new.organization_id
      and parent.id = new.id
      and parent.deleted_at is not null
      and child.deleted_at is null
  ) then
    raise exception using errcode = '23514', message = 'A deleted node cannot retain active children';
  end if;

  if exists (
    with recursive ancestry(id, parent_id, path, cycle) as (
      select n.id, n.parent_id, array[n.id]::uuid[], false
      from public.org_nodes as n
      where n.organization_id = new.organization_id and n.id = new.id
      union all
      select p.id, p.parent_id, a.path || p.id, p.id = any(a.path)
      from ancestry as a
      join public.org_nodes as p
        on p.organization_id = new.organization_id and p.id = a.parent_id
      where not a.cycle
    )
    select 1 from ancestry where cycle
  ) then
    raise exception using errcode = '23514', message = 'Organization trees cannot contain cycles';
  end if;

  return null;
end
$function$;

create or replace function private.write_org_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_organization_id uuid;
  v_entity_id uuid;
begin
  if tg_op <> 'INSERT' then
    v_before := to_jsonb(old);
  end if;
  if tg_op <> 'DELETE' then
    v_after := to_jsonb(new);
  end if;

  -- Keep audit history useful without copying any future secret field into it.
  v_before := v_before - 'token_hash' - 'secret';
  v_after := v_after - 'token_hash' - 'secret';
  v_row := coalesce(v_after, v_before);

  if tg_table_name = 'organizations' then
    v_organization_id := (v_row ->> 'id')::uuid;
  else
    v_organization_id := (v_row ->> 'organization_id')::uuid;
  end if;

  v_entity_id := coalesce(
    nullif(v_row ->> 'id', '')::uuid,
    nullif(v_row ->> 'user_id', '')::uuid,
    nullif(v_row ->> 'root_node_id', '')::uuid
  );

  insert into public.org_audit_log (
    organization_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data
  ) values (
    v_organization_id,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    v_entity_id,
    v_before,
    v_after
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

drop trigger if exists organizations_prepare_row on public.organizations;
create trigger organizations_prepare_row
before insert or update on public.organizations
for each row execute function private.prepare_organization_row();

drop trigger if exists org_memberships_prepare_row on public.org_memberships;
create trigger org_memberships_prepare_row
before insert or update on public.org_memberships
for each row execute function private.prepare_membership_row();

drop trigger if exists org_invitations_prepare_row on public.org_invitations;
create trigger org_invitations_prepare_row
before insert or update on public.org_invitations
for each row execute function private.prepare_invitation_row();

drop trigger if exists org_nodes_prepare_row on public.org_nodes;
create trigger org_nodes_prepare_row
before insert or update on public.org_nodes
for each row execute function private.prepare_org_node_row();

drop trigger if exists org_nodes_validate_deferred on public.org_nodes;
create constraint trigger org_nodes_validate_deferred
after insert or update on public.org_nodes
deferrable initially deferred
for each row execute function private.validate_org_node_deferred();

drop trigger if exists organizations_audit on public.organizations;
create trigger organizations_audit
after insert or update or delete on public.organizations
for each row execute function private.write_org_audit_log();

drop trigger if exists org_memberships_audit on public.org_memberships;
create trigger org_memberships_audit
after insert or update or delete on public.org_memberships
for each row execute function private.write_org_audit_log();

drop trigger if exists org_invitations_audit on public.org_invitations;
create trigger org_invitations_audit
after insert or update or delete on public.org_invitations
for each row execute function private.write_org_audit_log();

drop trigger if exists org_nodes_audit on public.org_nodes;
create trigger org_nodes_audit
after insert or update or delete on public.org_nodes
for each row execute function private.write_org_audit_log();

drop trigger if exists org_node_deletion_batches_audit on public.org_node_deletion_batches;
create trigger org_node_deletion_batches_audit
after insert or update or delete on public.org_node_deletion_batches
for each row execute function private.write_org_audit_log();

drop trigger if exists org_node_deletion_requests_audit on public.org_node_deletion_requests;
create trigger org_node_deletion_requests_audit
after insert or update or delete on public.org_node_deletion_requests
for each row execute function private.write_org_audit_log();

-- RLS is enabled and forced so a non-superuser table owner cannot accidentally
-- turn a client-side query into a bypass. SECURITY DEFINER functions still run
-- as the migration owner and perform their own explicit authorization checks.
alter table public.organizations enable row level security;
alter table public.organizations force row level security;
alter table public.org_memberships enable row level security;
alter table public.org_memberships force row level security;
alter table public.org_invitations enable row level security;
alter table public.org_invitations force row level security;
alter table public.org_nodes enable row level security;
alter table public.org_nodes force row level security;
alter table public.org_node_deletion_batches enable row level security;
alter table public.org_node_deletion_batches force row level security;
alter table public.org_node_deletion_requests enable row level security;
alter table public.org_node_deletion_requests force row level security;
alter table public.org_audit_log enable row level security;
alter table public.org_audit_log force row level security;

drop policy if exists organizations_member_select on public.organizations;
create policy organizations_member_select
on public.organizations
for select
to authenticated
using (private.current_org_role(id) is not null);

drop policy if exists org_memberships_member_select on public.org_memberships;
create policy org_memberships_member_select
on public.org_memberships
for select
to authenticated
using (private.current_org_role(organization_id) is not null);

drop policy if exists org_invitations_owner_select on public.org_invitations;
create policy org_invitations_owner_select
on public.org_invitations
for select
to authenticated
using (
  private.current_org_role(organization_id) = 'owner'::public.org_member_role
  and accepted_at is null
  and revoked_at is null
  and expires_at > clock_timestamp()
);

drop policy if exists org_nodes_member_select on public.org_nodes;
create policy org_nodes_member_select
on public.org_nodes
for select
to authenticated
using (
  private.current_org_role(organization_id) is not null
  and (
    deleted_at is null
    or private.current_org_role(organization_id) in ('owner', 'editor')
  )
);

drop policy if exists org_nodes_editor_insert on public.org_nodes;
create policy org_nodes_editor_insert
on public.org_nodes
for insert
to authenticated
with check (
  private.current_org_role(organization_id) in ('owner', 'editor')
  and deleted_at is null
  and deleted_by is null
  and deleted_batch_id is null
  and version = 1
  and created_by = auth.uid()
  and updated_by = auth.uid()
);

drop policy if exists org_nodes_editor_update on public.org_nodes;
-- There is deliberately no direct UPDATE policy. All node edits use
-- update_org_node(expected_version, patch), which makes the optimistic lock a
-- database requirement instead of a client convention.

-- There is deliberately no DELETE policy for org_nodes.

drop policy if exists org_node_deletion_batches_editor_select on public.org_node_deletion_batches;
create policy org_node_deletion_batches_editor_select
on public.org_node_deletion_batches
for select
to authenticated
using (private.current_org_role(organization_id) in ('owner', 'editor'));

drop policy if exists org_node_deletion_requests_editor_select on public.org_node_deletion_requests;
create policy org_node_deletion_requests_editor_select
on public.org_node_deletion_requests
for select
to authenticated
using (private.current_org_role(organization_id) in ('owner', 'editor'));

drop policy if exists org_audit_log_owner_select on public.org_audit_log;
create policy org_audit_log_owner_select
on public.org_audit_log
for select
to authenticated
using (private.current_org_role(organization_id) = 'owner'::public.org_member_role);

-- RPC: create an organization and its first company/root node atomically.
create or replace function public.create_organization(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_user_id uuid := private.require_auth_user();
  v_email text;
  v_organization_id uuid;
begin
  p_name := btrim(coalesce(p_name, ''));
  if char_length(p_name) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'Organization name must contain 1 to 80 characters';
  end if;

  select lower(btrim(u.email))
    into v_email
  from auth.users as u
  where u.id = v_user_id
    and u.email is not null
    and u.email_confirmed_at is not null;

  if v_email is null then
    raise exception using errcode = '28000', message = 'A verified email address is required';
  end if;

  insert into public.organizations (name, created_by, updated_by)
  values (p_name, v_user_id, v_user_id)
  returning id into v_organization_id;

  insert into public.org_memberships (
    organization_id, user_id, member_email, role, created_by, updated_by
  ) values (
    v_organization_id, v_user_id, v_email, 'owner', v_user_id, v_user_id
  );

  insert into public.org_nodes (
    organization_id, parent_id, type, name, title, notes, sort_order, created_by, updated_by
  ) values (
    v_organization_id, null, 'company', p_name, '组织中心', '', 0, v_user_id, v_user_id
  );

  return v_organization_id;
end
$function$;

-- RPC: owners create a pending email invitation. The record itself is the
-- invitation; the invitee proves control of the address by signing into Supabase.
create or replace function public.invite_org_member(
  p_organization_id uuid,
  p_email text,
  p_role text
)
returns uuid
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_user_id uuid := private.require_auth_user();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_role public.org_member_role;
  v_invitation_id uuid;
begin
  if char_length(v_email) not between 3 and 320 or position('@' in v_email) <= 1 then
    raise exception using errcode = '22023', message = 'A valid email address is required';
  end if;

  begin
    v_role := p_role::public.org_member_role;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Invitation role must be editor or viewer';
  end;

  if v_role not in ('editor', 'viewer') then
    raise exception using errcode = '22023', message = 'Invitation role must be editor or viewer';
  end if;

  -- Serialize invitations for one organization and avoid two active rows for
  -- the same email even under concurrent owner requests.
  perform 1
  from public.organizations as o
  where o.id = p_organization_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Organization not found';
  end if;

  -- Authorization is intentionally checked after the organization lock. A
  -- concurrent owner demotion/removal must become visible before this write.
  perform private.require_org_owner(p_organization_id);

  -- Recheck after taking the organization lock so an invitation acceptance
  -- racing this request cannot leave a new pending invite for an existing member.
  if exists (
    select 1
    from public.org_memberships as m
    where m.organization_id = p_organization_id
      and lower(m.member_email) = v_email
  ) then
    raise exception using errcode = '23505', message = 'This email is already a member';
  end if;

  update public.org_invitations
  set revoked_at = clock_timestamp(), revoked_by = v_user_id
  where organization_id = p_organization_id
    and email = v_email
    and accepted_at is null
    and revoked_at is null;

  insert into public.org_invitations (
    organization_id, email, role, invited_by
  ) values (
    p_organization_id, v_email, v_role, v_user_id
  )
  returning id into v_invitation_id;

  return v_invitation_id;
end
$function$;

-- RPC: accept every unexpired invitation that matches the current user's
-- verified auth.users.email. No caller-supplied email is trusted.
create or replace function public.accept_my_invitations()
returns integer
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_user_id uuid := private.require_auth_user();
  v_email text;
  v_invitation public.org_invitations%rowtype;
  v_count integer := 0;
begin
  select lower(btrim(u.email))
    into v_email
  from auth.users as u
  where u.id = v_user_id
    and u.email is not null
    and u.email_confirmed_at is not null;

  if v_email is null then
    raise exception using errcode = '28000', message = 'A verified email address is required';
  end if;

  for v_invitation in
    select i.*
    from public.org_invitations as i
    where i.email = v_email
      and i.accepted_at is null
      and i.revoked_at is null
      and i.expires_at > clock_timestamp()
    order by i.created_at, i.id
    for update skip locked
  loop
    insert into public.org_memberships (
      organization_id, user_id, member_email, role, created_by, updated_by
    ) values (
      v_invitation.organization_id,
      v_user_id,
      v_email,
      v_invitation.role,
      v_invitation.invited_by,
      v_user_id
    )
    on conflict (organization_id, user_id) do update
    set member_email = excluded.member_email,
        role = case
          when public.org_memberships.role = 'owner'::public.org_member_role
            then public.org_memberships.role
          else excluded.role
        end,
        updated_by = v_user_id;

    update public.org_invitations
    set accepted_at = clock_timestamp(), accepted_by = v_user_id
    where id = v_invitation.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$function$;

-- Optional owner operations used by future member-management UI. They preserve
-- at least one owner under concurrent requests by locking the organization row.
create or replace function public.set_org_member_role(
  p_organization_id uuid,
  p_user_id uuid,
  p_role text
)
returns void
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_actor uuid := private.require_auth_user();
  v_old_role public.org_member_role;
  v_new_role public.org_member_role;
begin
  begin
    v_new_role := p_role::public.org_member_role;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Invalid membership role';
  end;

  perform 1 from public.organizations where id = p_organization_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Organization not found';
  end if;
  perform private.require_org_owner(p_organization_id);

  select role into v_old_role
  from public.org_memberships
  where organization_id = p_organization_id and user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Membership not found';
  end if;

  if v_old_role = 'owner' and v_new_role <> 'owner' and (
    select count(*) from public.org_memberships
    where organization_id = p_organization_id and role = 'owner'
  ) <= 1 then
    raise exception using errcode = '23514', message = 'An organization must retain at least one owner';
  end if;

  update public.org_memberships
  set role = v_new_role, updated_by = v_actor
  where organization_id = p_organization_id and user_id = p_user_id;
end
$function$;

create or replace function public.remove_org_member(
  p_organization_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_role public.org_member_role;
begin
  perform 1 from public.organizations where id = p_organization_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Organization not found';
  end if;
  perform private.require_org_owner(p_organization_id);

  select role into v_role
  from public.org_memberships
  where organization_id = p_organization_id and user_id = p_user_id
  for update;

  if not found then
    return;
  end if;

  if v_role = 'owner' and (
    select count(*) from public.org_memberships
    where organization_id = p_organization_id and role = 'owner'
  ) <= 1 then
    raise exception using errcode = '23514', message = 'The last owner cannot be removed';
  end if;

  delete from public.org_memberships
  where organization_id = p_organization_id and user_id = p_user_id;
end
$function$;

create or replace function public.revoke_org_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_actor uuid := private.require_auth_user();
  v_organization_id uuid;
begin
  select organization_id into v_organization_id
  from public.org_invitations
  where id = p_invitation_id;

  if not found then
    return;
  end if;

  perform 1 from public.organizations where id = v_organization_id for update;
  if not found then
    return;
  end if;
  perform private.require_org_owner(v_organization_id);

  update public.org_invitations
  set revoked_at = clock_timestamp(), revoked_by = v_actor
  where id = p_invitation_id
    and accepted_at is null
    and revoked_at is null;
end
$function$;

-- Version-checked node autosave. Only the five fields used by the editor are
-- accepted; organization, ordering, actor, version and deletion metadata are
-- never caller-controlled.
create or replace function public.update_org_node(
  p_node_id uuid,
  p_expected_version bigint,
  p_patch jsonb
)
returns public.org_nodes
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_organization_id uuid;
  v_result public.org_nodes%rowtype;
begin
  perform private.require_auth_user();

  if p_expected_version is null or p_expected_version < 1 then
    raise exception using errcode = '22023', message = 'A positive expected version is required';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'Node patch must be a JSON object';
  end if;

  if exists (
    select 1
    from jsonb_object_keys(p_patch) as key(name)
    where key.name not in ('parent_id', 'type', 'name', 'title', 'notes')
  ) then
    raise exception using errcode = '22023', message = 'Node patch contains a protected or unknown field';
  end if;

  if p_patch = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Node patch cannot be empty';
  end if;

  select n.organization_id into v_organization_id
  from public.org_nodes as n
  where n.id = p_node_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Node not found';
  end if;

  perform 1
  from public.organizations as o
  where o.id = v_organization_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Organization not found';
  end if;

  perform private.require_org_editor(v_organization_id);

  begin
    update public.org_nodes as n
    set parent_id = case
          when p_patch ? 'parent_id' then (p_patch ->> 'parent_id')::uuid
          else n.parent_id
        end,
        type = case
          when p_patch ? 'type' then (p_patch ->> 'type')::public.org_node_type
          else n.type
        end,
        name = case
          when p_patch ? 'name' then btrim(p_patch ->> 'name')
          else n.name
        end,
        title = case
          when p_patch ? 'title' then coalesce(p_patch ->> 'title', '')
          else n.title
        end,
        notes = case
          when p_patch ? 'notes' then coalesce(p_patch ->> 'notes', '')
          else n.notes
        end
    where n.id = p_node_id
      and n.organization_id = v_organization_id
      and n.deleted_at is null
      and n.version = p_expected_version
    returning n.* into v_result;
  exception
    when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Node patch contains an invalid UUID or node type';
  end;

  if not found then
    raise exception using errcode = '40001', message = 'Node version changed or node was deleted; reload and retry';
  end if;

  return v_result;
end
$function$;

-- Soft-delete an active root plus every currently active descendant in one
-- transaction and mark every row with the same recovery batch id. The client
-- mutation UUID is the batch UUID, so replaying that operation after a later
-- restore cannot create a second deletion.
drop function if exists public.soft_delete_org_subtree(uuid);
create or replace function public.soft_delete_org_subtree(
  p_root_node_id uuid,
  p_mutation_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_actor uuid := private.require_auth_user();
  v_organization_id uuid;
  v_existing_batch public.org_node_deletion_batches%rowtype;
  v_existing_request public.org_node_deletion_requests%rowtype;
  v_current_batch_id uuid;
  v_batch_id uuid := p_mutation_id;
  v_deleted_at timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_mutation_id is null then
    raise exception using errcode = '22023', message = 'A deletion mutation id is required';
  end if;

  select r.* into v_existing_request
  from public.org_node_deletion_requests as r
  where r.mutation_id = p_mutation_id
  for update;

  if found then
    if v_existing_request.root_node_id is distinct from p_root_node_id then
      raise exception using errcode = '23505', message = 'Deletion mutation id was already used for another root';
    end if;
    perform private.require_org_editor(v_existing_request.organization_id);
    return v_existing_request.batch_id;
  end if;

  -- A completed mutation remains recorded after restore. A delayed replay
  -- therefore returns the original batch without deleting anything again.
  select b.* into v_existing_batch
  from public.org_node_deletion_batches as b
  where b.id = p_mutation_id
  for update;

  if found then
    if v_existing_batch.root_node_id is distinct from p_root_node_id then
      raise exception using errcode = '23505', message = 'Deletion mutation id was already used for another root';
    end if;
    perform private.require_org_editor(v_existing_batch.organization_id);
    insert into public.org_node_deletion_requests (
      mutation_id, organization_id, root_node_id, batch_id, requested_by
    ) values (
      p_mutation_id,
      v_existing_batch.organization_id,
      p_root_node_id,
      v_existing_batch.id,
      v_actor
    ) on conflict (mutation_id) do nothing;
    return v_existing_batch.id;
  end if;

  select n.organization_id, n.deleted_batch_id
    into v_organization_id, v_current_batch_id
  from public.org_nodes as n
  where n.id = p_root_node_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Node not found';
  end if;

  perform private.require_org_editor(v_organization_id);

  -- Retry-safe for an offline mutation that reached the server but whose
  -- response was lost.
  if v_current_batch_id is not null then
    insert into public.org_node_deletion_requests (
      mutation_id, organization_id, root_node_id, batch_id, requested_by
    ) values (
      p_mutation_id, v_organization_id, p_root_node_id, v_current_batch_id, v_actor
    ) on conflict (mutation_id) do nothing;
    return v_current_batch_id;
  end if;

  insert into public.org_node_deletion_batches (
    id, organization_id, root_node_id, deleted_at, deleted_by
  ) values (
    v_batch_id, v_organization_id, p_root_node_id, v_deleted_at, v_actor
  )
  on conflict (id) do nothing;

  if not found then
    select b.* into v_existing_batch
    from public.org_node_deletion_batches as b
    where b.id = p_mutation_id
    for update;

    if v_existing_batch.organization_id is distinct from v_organization_id
      or v_existing_batch.root_node_id is distinct from p_root_node_id then
      raise exception using errcode = '23505', message = 'Deletion mutation id was already used for another operation';
    end if;
    insert into public.org_node_deletion_requests (
      mutation_id, organization_id, root_node_id, batch_id, requested_by
    ) values (
      p_mutation_id, v_organization_id, p_root_node_id, v_existing_batch.id, v_actor
    ) on conflict (mutation_id) do nothing;
    return v_existing_batch.id;
  end if;

  insert into public.org_node_deletion_requests (
    mutation_id, organization_id, root_node_id, batch_id, requested_by
  ) values (
    p_mutation_id, v_organization_id, p_root_node_id, v_batch_id, v_actor
  );

  with recursive subtree(id) as (
    select n.id
    from public.org_nodes as n
    where n.organization_id = v_organization_id
      and n.id = p_root_node_id
      and n.deleted_at is null
    union
    select child.id
    from public.org_nodes as child
    join subtree as parent on child.parent_id = parent.id
    where child.organization_id = v_organization_id
      and child.deleted_at is null
  )
  update public.org_nodes as n
  set deleted_at = v_deleted_at,
      deleted_by = v_actor,
      deleted_batch_id = v_batch_id
  where n.organization_id = v_organization_id
    and n.id in (select id from subtree);

  get diagnostics v_count = row_count;

  update public.org_node_deletion_batches
  set affected_count = v_count
  where id = v_batch_id;

  return v_batch_id;
end
$function$;

-- Restore only the explicitly expected deletion batch. The independent restore
-- mutation id makes retries return the original result and prevents a delayed
-- restore from touching a later deletion of the same root.
drop function if exists public.restore_org_subtree(uuid);
create or replace function public.restore_org_subtree(
  p_root_node_id uuid,
  p_expected_batch_id uuid,
  p_mutation_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_actor uuid := private.require_auth_user();
  v_organization_id uuid;
  v_batch_id uuid;
  v_batch public.org_node_deletion_batches%rowtype;
  v_prior_restore public.org_node_deletion_batches%rowtype;
  v_count integer;
begin
  if p_expected_batch_id is null or p_mutation_id is null then
    raise exception using errcode = '22023', message = 'Expected batch id and restore mutation id are required';
  end if;

  select b.* into v_prior_restore
  from public.org_node_deletion_batches as b
  where b.restore_mutation_id = p_mutation_id
  for update;

  if found then
    if v_prior_restore.id is distinct from p_expected_batch_id
      or v_prior_restore.root_node_id is distinct from p_root_node_id then
      raise exception using errcode = '23505', message = 'Restore mutation id was already used for another batch';
    end if;
    perform private.require_org_editor(v_prior_restore.organization_id);
    return v_prior_restore.affected_count;
  end if;

  select n.organization_id, n.deleted_batch_id
    into v_organization_id, v_batch_id
  from public.org_nodes as n
  where n.id = p_root_node_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Node not found';
  end if;

  perform private.require_org_editor(v_organization_id);

  select b.*
    into v_batch
  from public.org_node_deletion_batches as b
  where b.organization_id = v_organization_id and b.id = p_expected_batch_id
  for update;

  if not found or v_batch.root_node_id is distinct from p_root_node_id then
    raise exception using errcode = '22023', message = 'Expected deletion batch does not belong to this root';
  end if;

  if v_batch.restored_at is not null then
    return 0;
  end if;

  if v_batch_id is distinct from p_expected_batch_id then
    raise exception using errcode = '40001', message = 'Root deletion batch changed; reload and retry';
  end if;

  if exists (
    select 1
    from public.org_nodes as child
    join public.org_nodes as parent
      on parent.organization_id = child.organization_id and parent.id = child.parent_id
    where child.organization_id = v_organization_id
      and child.deleted_batch_id = p_expected_batch_id
      and parent.deleted_at is not null
      and parent.deleted_batch_id is distinct from p_expected_batch_id
  ) then
    raise exception using errcode = '23514', message = 'Restore the deleted parent batch first';
  end if;

  update public.org_nodes
  set deleted_at = null,
      deleted_by = null,
      deleted_batch_id = null
  where organization_id = v_organization_id
    and deleted_batch_id = p_expected_batch_id;

  get diagnostics v_count = row_count;

  update public.org_node_deletion_batches
  set restored_at = clock_timestamp(),
      restored_by = v_actor,
      restore_mutation_id = p_mutation_id
  where organization_id = v_organization_id
    and id = p_expected_batch_id
    and restored_at is null;

  return v_count;
end
$function$;

-- Move one sibling up/down. All active siblings are locked, the desired order
-- is calculated once, and changed sort_order values commit atomically.
create or replace function public.reorder_org_node(
  p_node_id uuid,
  p_direction text
)
returns boolean
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_organization_id uuid;
  v_parent_id uuid;
  v_ids uuid[];
  v_index integer;
  v_target_index integer;
  v_swap uuid;
begin
  if p_direction not in ('up', 'down') then
    raise exception using errcode = '22023', message = 'Direction must be up or down';
  end if;

  select n.organization_id, n.parent_id
    into v_organization_id, v_parent_id
  from public.org_nodes as n
  where n.id = p_node_id and n.deleted_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'Active node not found';
  end if;

  perform private.require_org_editor(v_organization_id);

  -- Row locks are acquired in a deterministic order to avoid concurrent
  -- reorder operations interleaving or deadlocking.
  perform 1
  from public.org_nodes as n
  where n.organization_id = v_organization_id
    and n.parent_id is not distinct from v_parent_id
    and n.deleted_at is null
  order by n.sort_order, n.id
  for update;

  select array_agg(n.id order by n.sort_order, n.id)
    into v_ids
  from public.org_nodes as n
  where n.organization_id = v_organization_id
    and n.parent_id is not distinct from v_parent_id
    and n.deleted_at is null;

  v_index := array_position(v_ids, p_node_id);
  if v_index is null then
    raise exception using errcode = '40001', message = 'Node changed during reorder; reload and retry';
  end if;

  v_target_index := case when p_direction = 'up' then v_index - 1 else v_index + 1 end;
  if v_target_index < 1 or v_target_index > cardinality(v_ids) then
    return false;
  end if;

  v_swap := v_ids[v_index];
  v_ids[v_index] := v_ids[v_target_index];
  v_ids[v_target_index] := v_swap;

  with desired as (
    select x.id, (x.ordinality * 10)::integer as sort_order
    from unnest(v_ids) with ordinality as x(id, ordinality)
  )
  update public.org_nodes as n
  set sort_order = desired.sort_order
  from desired
  where n.organization_id = v_organization_id
    and n.id = desired.id
    and n.sort_order is distinct from desired.sort_order;

  return true;
end
$function$;

-- Optional exact-list sorter for future drag-and-drop clients. Every active
-- sibling and every expected version must match, otherwise nothing is changed.
create or replace function public.reorder_org_nodes(
  p_organization_id uuid,
  p_parent_id uuid,
  p_ordered_node_ids uuid[],
  p_expected_versions jsonb
)
returns setof public.org_nodes
language plpgsql
security definer
set search_path = ''
set row_security = off
as $function$
declare
  v_sibling_count integer;
begin
  perform private.require_org_editor(p_organization_id);

  if p_ordered_node_ids is null
    or array_position(p_ordered_node_ids, null) is not null
    or (
      select count(*) from unnest(p_ordered_node_ids) as x(id)
    ) <> (
      select count(distinct id) from unnest(p_ordered_node_ids) as x(id)
    ) then
    raise exception using errcode = '22023', message = 'Ordered node ids must be a unique non-null array';
  end if;

  if p_expected_versions is null or jsonb_typeof(p_expected_versions) <> 'object' then
    raise exception using errcode = '22023', message = 'Expected versions must be a JSON object';
  end if;

  perform 1
  from public.org_nodes as n
  where n.organization_id = p_organization_id
    and n.parent_id is not distinct from p_parent_id
    and n.deleted_at is null
  order by n.id
  for update;

  select count(*) into v_sibling_count
  from public.org_nodes as n
  where n.organization_id = p_organization_id
    and n.parent_id is not distinct from p_parent_id
    and n.deleted_at is null;

  if v_sibling_count <> cardinality(p_ordered_node_ids)
    or exists (
      select 1
      from unnest(p_ordered_node_ids) as requested(id)
      where not exists (
        select 1 from public.org_nodes as n
        where n.organization_id = p_organization_id
          and n.parent_id is not distinct from p_parent_id
          and n.deleted_at is null
          and n.id = requested.id
      )
    ) then
    raise exception using errcode = '40001', message = 'Sibling set changed; reload and retry';
  end if;

  if exists (
    select 1
    from public.org_nodes as n
    where n.organization_id = p_organization_id
      and n.parent_id is not distinct from p_parent_id
      and n.deleted_at is null
      and (
        not (p_expected_versions ? n.id::text)
        or (p_expected_versions ->> n.id::text)::bigint <> n.version
      )
  ) then
    raise exception using errcode = '40001', message = 'A sibling version changed; reload and retry';
  end if;

  with desired as (
    select x.id, (x.ordinality * 10)::integer as sort_order
    from unnest(p_ordered_node_ids) with ordinality as x(id, ordinality)
  )
  update public.org_nodes as n
  set sort_order = desired.sort_order
  from desired
  where n.organization_id = p_organization_id
    and n.id = desired.id
    and n.sort_order is distinct from desired.sort_order;

  return query
  select n.*
  from public.org_nodes as n
  where n.organization_id = p_organization_id
    and n.id = any(p_ordered_node_ids)
  order by n.sort_order, n.id;
end
$function$;

-- Explicit grants. Start from no client privileges so a re-run also removes
-- accidental grants made during development.
revoke all on table public.organizations from anon, authenticated;
revoke all on table public.org_memberships from anon, authenticated;
revoke all on table public.org_invitations from anon, authenticated;
revoke all on table public.org_nodes from anon, authenticated;
revoke all on table public.org_node_deletion_batches from anon, authenticated;
revoke all on table public.org_node_deletion_requests from anon, authenticated;
revoke all on table public.org_audit_log from anon, authenticated;

grant select on table public.organizations to authenticated;
grant select on table public.org_memberships to authenticated;
grant select on table public.org_invitations to authenticated;
grant select on table public.org_nodes to authenticated;
grant select on table public.org_node_deletion_batches to authenticated;
grant select on table public.org_node_deletion_requests to authenticated;
grant select on table public.org_audit_log to authenticated;

-- Online inserts send the business columns; offline replay sends the complete
-- normalized object. The BEFORE trigger overwrites every server-owned field.
grant insert (
  id, organization_id, parent_id, type, name, title, notes, sort_order,
  version, updated_at, updated_by, deleted_at, deleted_batch_id
) on public.org_nodes to authenticated;

-- No direct UPDATE grant is issued. Normal autosave must use update_org_node so
-- every write carries an expected version checked by the database.

revoke all on function private.current_org_role(uuid) from public, anon, authenticated;
revoke all on function private.require_auth_user() from public, anon, authenticated;
revoke all on function private.require_org_editor(uuid) from public, anon, authenticated;
revoke all on function private.require_org_owner(uuid) from public, anon, authenticated;
revoke all on function private.prepare_organization_row() from public, anon, authenticated;
revoke all on function private.prepare_membership_row() from public, anon, authenticated;
revoke all on function private.prepare_invitation_row() from public, anon, authenticated;
revoke all on function private.prepare_org_node_row() from public, anon, authenticated;
revoke all on function private.validate_org_node_deferred() from public, anon, authenticated;
revoke all on function private.write_org_audit_log() from public, anon, authenticated;
grant execute on function private.current_org_role(uuid) to authenticated;

revoke all on function public.create_organization(text) from public, anon, authenticated;
revoke all on function public.invite_org_member(uuid, text, text) from public, anon, authenticated;
revoke all on function public.accept_my_invitations() from public, anon, authenticated;
revoke all on function public.set_org_member_role(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.remove_org_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.revoke_org_invitation(uuid) from public, anon, authenticated;
revoke all on function public.update_org_node(uuid, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.soft_delete_org_subtree(uuid, uuid) from public, anon, authenticated;
revoke all on function public.restore_org_subtree(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.reorder_org_node(uuid, text) from public, anon, authenticated;
revoke all on function public.reorder_org_nodes(uuid, uuid, uuid[], jsonb) from public, anon, authenticated;

grant execute on function public.create_organization(text) to authenticated;
grant execute on function public.invite_org_member(uuid, text, text) to authenticated;
grant execute on function public.accept_my_invitations() to authenticated;
grant execute on function public.set_org_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_org_member(uuid, uuid) to authenticated;
grant execute on function public.revoke_org_invitation(uuid) to authenticated;
grant execute on function public.update_org_node(uuid, bigint, jsonb) to authenticated;
grant execute on function public.soft_delete_org_subtree(uuid, uuid) to authenticated;
grant execute on function public.restore_org_subtree(uuid, uuid, uuid) to authenticated;
grant execute on function public.reorder_org_node(uuid, text) to authenticated;
grant execute on function public.reorder_org_nodes(uuid, uuid, uuid[], jsonb) to authenticated;

-- Full row images make UPDATE/soft-delete payloads useful to Realtime clients.
alter table public.organizations replica identity full;
alter table public.org_memberships replica identity full;
alter table public.org_invitations replica identity full;
alter table public.org_nodes replica identity full;
alter table public.org_node_deletion_batches replica identity full;

-- Supabase creates this publication. The guards also let the schema be checked
-- in a plain Postgres instance where the publication is absent.
do $realtime$
declare
  v_table text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array[
      'organizations',
      'org_memberships',
      'org_invitations',
      'org_nodes',
      'org_node_deletion_batches'
    ]
    loop
      if not exists (
        select 1
        from pg_catalog.pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end
$realtime$;

comment on table public.organizations is 'Organizations visible only to their authenticated members.';
comment on table public.org_memberships is 'Organization membership and owner/editor/viewer authorization source.';
comment on table public.org_invitations is 'Owner-created, expiring email invitations accepted via verified auth email.';
comment on table public.org_nodes is 'Versioned organization-tree nodes with batch soft deletion.';
comment on table public.org_node_deletion_batches is 'Recovery metadata for one atomic subtree soft deletion.';
comment on table public.org_node_deletion_requests is 'Permanent request-to-batch mapping for replay-safe subtree deletion.';
comment on table public.org_audit_log is 'Append-only organization mutation audit trail, readable by owners.';
comment on column public.org_nodes.version is 'Incremented by the database on every UPDATE; update_org_node enforces the expected value.';
comment on function public.accept_my_invitations() is 'Accepts active invitations matching the caller verified auth.users.email.';

commit;

