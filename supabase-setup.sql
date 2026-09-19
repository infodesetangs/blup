-- =====================================================================
--  FLARE 🔥  —  Schéma Supabase
--  À coller en entier dans Supabase > SQL Editor > New query > Run.
--  Le script peut être relancé sans danger (il nettoie avant de recréer
--  les règles de sécurité).
-- =====================================================================

-- ---------- PROFILS ---------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  bio          text not null default '' check (char_length(bio) <= 200),
  photo_url    text,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Création automatique du profil à l'inscription
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    lower(new.raw_user_meta_data->>'username'),
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), new.raw_user_meta_data->>'username')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- AMIS ------------------------------------------------------
create table if not exists public.friendships (
  id         bigint generated always as identity primary key,
  requester  uuid not null references public.profiles(id) on delete cascade,
  addressee  uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  check (requester <> addressee)
);
-- une seule relation par paire d'utilisateurs (dans un sens ou dans l'autre)
create unique index if not exists friendships_pair_uniq
  on public.friendships (least(requester, addressee), greatest(requester, addressee));
alter table public.friendships enable row level security;

drop policy if exists "friendships_select" on public.friendships;
create policy "friendships_select" on public.friendships
  for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

drop policy if exists "friendships_insert" on public.friendships;
create policy "friendships_insert" on public.friendships
  for insert to authenticated
  with check (requester = auth.uid() and status = 'pending');

drop policy if exists "friendships_update" on public.friendships;
create policy "friendships_update" on public.friendships
  for update to authenticated
  using (addressee = auth.uid())
  with check (addressee = auth.uid() and status = 'accepted');

drop policy if exists "friendships_delete" on public.friendships;
create policy "friendships_delete" on public.friendships
  for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and ((requester = a and addressee = b) or (requester = b and addressee = a))
  );
$$;

-- ---------- GROUPES ---------------------------------------------------
create table if not exists public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 40),
  photo_url  text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  primary key (group_id, user_id)
);
alter table public.groups enable row level security;
alter table public.group_members enable row level security;

create or replace function public.is_group_member(gid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.group_members where group_id = gid and user_id = auth.uid());
$$;

drop policy if exists "groups_select" on public.groups;
create policy "groups_select" on public.groups
  for select to authenticated
  using (created_by = auth.uid() or public.is_group_member(id));

drop policy if exists "groups_insert" on public.groups;
create policy "groups_insert" on public.groups
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "group_members_select" on public.group_members;
create policy "group_members_select" on public.group_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_group_member(group_id));

drop policy if exists "group_members_insert" on public.group_members;
create policy "group_members_insert" on public.group_members
  for insert to authenticated
  with check (exists (select 1 from public.groups g where g.id = group_id and g.created_by = auth.uid()));

-- ---------- MESSAGES & SNAPS -----------------------------------------
create table if not exists public.messages (
  id           bigint generated always as identity primary key,
  sender_id    uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid references public.profiles(id) on delete cascade,
  group_id     uuid references public.groups(id) on delete cascade,
  kind         text not null default 'text' check (kind in ('text', 'snap')),
  body         text check (char_length(body) <= 2000),
  media_url    text,
  media_type   text check (media_type in ('image', 'video')),
  created_at   timestamptz not null default now(),
  check ((recipient_id is not null and group_id is null)
      or (recipient_id is null and group_id is not null))
);
create index if not exists messages_recipient_idx on public.messages (recipient_id, created_at desc);
create index if not exists messages_group_idx     on public.messages (group_id, created_at desc);
create index if not exists messages_sender_idx    on public.messages (sender_id, created_at desc);
alter table public.messages enable row level security;

drop policy if exists "messages_select" on public.messages;
create policy "messages_select" on public.messages
  for select to authenticated
  using (
    sender_id = auth.uid()
    or recipient_id = auth.uid()
    or (group_id is not null and public.is_group_member(group_id))
  );

drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and (
      (recipient_id is not null and public.are_friends(auth.uid(), recipient_id))
      or (group_id is not null and public.is_group_member(group_id))
    )
  );

-- ---------- STORIES ---------------------------------------------------
create table if not exists public.stories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  media_url  text not null,
  media_type text not null check (media_type in ('image', 'video')),
  created_at timestamptz not null default now()
);
create index if not exists stories_created_idx on public.stories (created_at desc);

create table if not exists public.story_views (
  story_id  uuid not null references public.stories(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);
create table if not exists public.story_likes (
  story_id   uuid not null references public.stories(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (story_id, user_id)
);
create table if not exists public.story_comments (
  id         bigint generated always as identity primary key,
  story_id   uuid not null references public.stories(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

alter table public.stories        enable row level security;
alter table public.story_views    enable row level security;
alter table public.story_likes    enable row level security;
alter table public.story_comments enable row level security;

-- Les stories sont visibles par tous les utilisateurs connectés (amis + "Découvrir")
drop policy if exists "stories_select" on public.stories;
create policy "stories_select" on public.stories
  for select to authenticated using (true);
drop policy if exists "stories_insert" on public.stories;
create policy "stories_insert" on public.stories
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "stories_delete" on public.stories;
create policy "stories_delete" on public.stories
  for delete to authenticated using (user_id = auth.uid());

-- Vues : visibles par le spectateur et par le propriétaire de la story
drop policy if exists "story_views_select" on public.story_views;
create policy "story_views_select" on public.story_views
  for select to authenticated
  using (viewer_id = auth.uid()
         or exists (select 1 from public.stories s where s.id = story_views.story_id and s.user_id = auth.uid()));
drop policy if exists "story_views_insert" on public.story_views;
create policy "story_views_insert" on public.story_views
  for insert to authenticated with check (viewer_id = auth.uid());

-- Likes
drop policy if exists "story_likes_select" on public.story_likes;
create policy "story_likes_select" on public.story_likes
  for select to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from public.stories s where s.id = story_likes.story_id and s.user_id = auth.uid()));
drop policy if exists "story_likes_insert" on public.story_likes;
create policy "story_likes_insert" on public.story_likes
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "story_likes_delete" on public.story_likes;
create policy "story_likes_delete" on public.story_likes
  for delete to authenticated using (user_id = auth.uid());

-- Commentaires / réponses
drop policy if exists "story_comments_select" on public.story_comments;
create policy "story_comments_select" on public.story_comments
  for select to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from public.stories s where s.id = story_comments.story_id and s.user_id = auth.uid()));
drop policy if exists "story_comments_insert" on public.story_comments;
create policy "story_comments_insert" on public.story_comments
  for insert to authenticated with check (user_id = auth.uid());

-- ---------- STOCKAGE DES PHOTOS / VIDÉOS -----------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('flare-media', 'flare-media', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

drop policy if exists "flare_media_read" on storage.objects;
create policy "flare_media_read" on storage.objects
  for select using (bucket_id = 'flare-media');

drop policy if exists "flare_media_insert" on storage.objects;
create policy "flare_media_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'flare-media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "flare_media_delete" on storage.objects;
create policy "flare_media_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'flare-media' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- TEMPS RÉEL ------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['messages','friendships','group_members','stories',
                           'story_views','story_likes','story_comments'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
