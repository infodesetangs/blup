/* ================================================================
   FLARE 🔥 — version Supabase
   Toutes les données (comptes, amis, messages, snaps, stories, likes,
   commentaires, vues) sont dans une base partagée + temps réel.
   ================================================================ */

// ==================== CONFIG ====================
// Supabase > Project Settings > API : copie "Project URL" et la clé "anon public"
const SUPABASE_URL = 'COLLE_ICI_TON_PROJECT_URL';
const SUPABASE_ANON_KEY = 'COLLE_ICI_TA_CLE_ANON';

// Supabase exige un e-mail : on fabrique un faux e-mail à partir du nom d'utilisateur.
// Aucun e-mail n'est jamais envoyé tant que « Confirm email » est DÉSACTIVÉ dans Supabase.
// Si tu vois « Email address ... is invalid », mets ici un domaine qui existe vraiment.
const EMAIL_DOMAIN = 'gmail.com';

const BUCKET = 'flare-media';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_VIDEO_MB = 40;

const CONFIGURED = !SUPABASE_URL.includes('COLLE_ICI') && !SUPABASE_ANON_KEY.includes('COLLE_ICI');
const sb = (CONFIGURED && typeof supabase !== 'undefined')
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// ==================== STATE ====================
let me = null;                    // ma ligne "profiles"
const profiles = new Map();       // cache id -> profil
let friendships = [];             // toutes mes relations (pending + accepted)
let friends = [];                 // profils de mes amis
let groups = [];                  // mes groupes (avec .members = [ids])
let onlineIds = new Set();

let currentChat = null;           // { type: 'dm'|'group', id }
let activeView = 'auth';
let previousView = 'chats';
let renderedIds = new Set();

let cameraStream = null;
let facingMode = 'user';
let torchOn = false;
let capturedBlob = null;
let capturedType = null;          // 'image' | 'video'
let capturedUrl = null;

let selectedGroupMembers = new Set();
let groupPhotoBlob = null;
let groupPhotoDefaultHTML = '';

let viewingStories = [];
let currentStoryIndex = 0;
let storyReturnView = 'stories';
let storyTimer = null;
let storyToken = 0;
let storyStartedAt = 0;
let storyDuration = 5000;
let storyElapsed = 0;
let likeBusy = false;

let realtimeChannel = null;
let presenceChannel = null;
let hasSubscribedOnce = false;
let chatListSeq = 0;
let chatListTimer = null;
let busy = false;

// ==================== HELPERS ====================
const $ = (id) => document.getElementById(id);

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initial(name) {
    return (Array.from(String(name || '?'))[0] || '?').toUpperCase();
}

function avatarInner(p) {
    if (p && p.photo_url) return `<img src="${esc(p.photo_url)}" alt="">`;
    return esc(initial(p && p.display_name));
}

function truncate(s, n = 40) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

let toastTimer = null;
function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function errMsg(e) {
    const m = (e && (e.message || e.error_description)) || 'Erreur inconnue';
    if (/bucket not found/i.test(m)) return 'Stockage introuvable : relance le SQL (bucket flare-media)';
    if (/row-level security|violates row/i.test(m)) return 'Action refusée (êtes-vous bien amis / membres ?)';
    return m;
}

function setBusy(v) {
    busy = v;
    document.body.classList.toggle('busy', v);
}

function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return "à l'instant";
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min';
    if (diff < 86400000) return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    return d.getDate() + '/' + (d.getMonth() + 1);
}

function getTimeAgo(ts) {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return "à l'instant";
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' h';
    return Math.floor(diff / 86400000) + ' j';
}

function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function cleanQuery(q) {
    return String(q || '').replace(/[^\p{L}\p{N}_ ]/gu, '').trim();
}

function extFromType(type) {
    if (!type) return 'mp4';
    if (type.includes('quicktime')) return 'mov';
    if (type.includes('webm')) return 'webm';
    if (type.includes('png')) return 'png';
    if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
    return 'mp4';
}

function ms(ts) { return new Date(ts).getTime(); }

// "Lu / non lu" mémorisé sur l'appareil
function readKey(key) { return 'flare_read_' + me.id + '_' + key; }
function getLastRead(key) {
    try { return Number(localStorage.getItem(readKey(key))) || 0; } catch { return 0; }
}
function markRead(key, ts) {
    try { localStorage.setItem(readKey(key), String(ts || Date.now())); } catch { /* ignore */ }
}

function keyOf(m) {
    if (m.group_id) return 'grp:' + m.group_id;
    return 'dm:' + (m.sender_id === me.id ? m.recipient_id : m.sender_id);
}
function chatKeyOf(chat) { return (chat.type === 'group' ? 'grp:' : 'dm:') + chat.id; }

async function fetchProfiles(ids, force = false) {
    const wanted = [...new Set(ids)].filter(id => id && (force || !profiles.has(id)));
    if (!wanted.length) return;
    const { data, error } = await sb.from('profiles').select('*').in('id', wanted);
    if (error) return console.error('fetchProfiles', error);
    (data || []).forEach(p => profiles.set(p.id, p));
}

function getProfile(id) {
    return id === me.id ? me : profiles.get(id);
}

// ==================== IMAGES / UPLOAD ====================
function compressImage(file, maxDim = 1280, quality = 0.82, square = false) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            let sx = 0, sy = 0, sw = img.width, sh = img.height;
            if (square) {
                const min = Math.min(img.width, img.height);
                sx = (img.width - min) / 2; sy = (img.height - min) / 2; sw = sh = min;
            }
            const scale = Math.min(1, maxDim / Math.max(sw, sh));
            const w = Math.max(1, Math.round(sw * scale));
            const h = Math.max(1, Math.round(sh * scale));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
            URL.revokeObjectURL(url);
            c.toBlob(b => b ? resolve(b) : reject(new Error('Image illisible')), 'image/jpeg', quality);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible')); };
        img.src = url;
    });
}

async function uploadMedia(blob, ext, prefix = 'snap') {
    const path = `${me.id}/${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
        contentType: blob.type || (ext === 'jpg' ? 'image/jpeg' : 'video/mp4'),
        cacheControl: '31536000'
    });
    if (error) throw error;
    return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

// Prépare un fichier choisi (photo compressée / vidéo vérifiée). Renvoie { blob, type } ou null
async function prepareFile(file) {
    if (file.type.startsWith('image/')) {
        return { blob: await compressImage(file), type: 'image' };
    }
    if (file.type.startsWith('video/')) {
        if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
            toast(`Vidéo trop lourde (max ${MAX_VIDEO_MB} Mo)`);
            return null;
        }
        return { blob: file, type: 'video' };
    }
    toast('Format non supporté');
    return null;
}

// ==================== INIT ====================
async function init() {
    buildEmojiPicker();
    groupPhotoDefaultHTML = $('group-photo-preview').innerHTML;

    // Mettre en pause l'avance auto d'une story pendant qu'on écrit une réponse
    const replyInput = $('story-reply-input');
    replyInput.addEventListener('focus', pauseStory);
    replyInput.addEventListener('blur', resumeStory);

    if (!sb) {
        $('auth-screen').querySelector('.auth-tagline').textContent =
            "⚠️ Configure SUPABASE_URL et SUPABASE_ANON_KEY dans app.js";
        return;
    }

    sb.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT' && me) resetToAuth();
    });

    try {
        const { data } = await sb.auth.getSession();
        if (data && data.session) await startApp(data.session.user.id);
    } catch (e) {
        console.error(e);
    }
}

// ==================== AUTH ====================
function showLogin() {
    $('login-form').style.display = 'flex';
    $('register-form').style.display = 'none';
}
function showRegister() {
    $('login-form').style.display = 'none';
    $('register-form').style.display = 'flex';
}

function usernameToEmail(u) { return `flare_${u}@${EMAIL_DOMAIN}`; }

function authErrorMessage(error) {
    const m = error.message || '';
    if (/already registered|already exists/i.test(m)) return "Ce nom d'utilisateur est déjà pris";
    if (/invalid login/i.test(m)) return "Nom d'utilisateur ou mot de passe incorrect";
    if (/email.*invalid|invalid.*email/i.test(m)) return "E-mail refusé : change EMAIL_DOMAIN dans app.js";
    if (/database error/i.test(m)) return "Erreur base de données : as-tu lancé le SQL ?";
    return m || 'Erreur de connexion';
}

async function register() {
    if (busy || !sb) return;
    const username = $('reg-username').value.trim().toLowerCase();
    const display = $('reg-display').value.trim().slice(0, 40);
    const pass = $('reg-password').value;
    const pass2 = $('reg-password2').value;

    if (!username || !display || !pass) return toast('Remplis tous les champs');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return toast("Nom d'utilisateur : 3 à 20 caractères (a-z, 0-9, _)");
    if (pass.length < 6) return toast('Mot de passe trop court (6 min)');
    if (pass !== pass2) return toast('Les mots de passe ne correspondent pas');

    setBusy(true);
    try {
        const { data, error } = await sb.auth.signUp({
            email: usernameToEmail(username),
            password: pass,
            options: { data: { username, display_name: display } }
        });
        if (error) return toast(authErrorMessage(error));
        if (!data.session) return toast('Désactive « Confirm email » dans Supabase (Authentication > Providers > Email)');
        await startApp(data.user.id);
        toast('Bienvenue sur Flare 🔥');
    } catch (e) {
        console.error(e);
        toast('Erreur réseau, réessaie');
    } finally {
        setBusy(false);
    }
}

async function login() {
    if (busy || !sb) return;
    const username = $('login-username').value.trim().toLowerCase();
    const pass = $('login-password').value;
    if (!username || !pass) return toast('Remplis tous les champs');

    setBusy(true);
    try {
        const { data, error } = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password: pass });
        if (error) return toast(authErrorMessage(error));
        await startApp(data.user.id);
        toast('Content de te revoir 🔥');
    } catch (e) {
        console.error(e);
        toast('Erreur réseau, réessaie');
    } finally {
        setBusy(false);
    }
}

async function logout() {
    try { await sb.auth.signOut(); } catch (e) { console.error(e); }
    resetToAuth();
}

function resetToAuth() {
    stopRealtime();
    stopCamera();
    clearTimeout(storyTimer);
    me = null;
    profiles.clear();
    friendships = []; friends = []; groups = [];
    onlineIds = new Set();
    currentChat = null;
    activeView = 'auth';
    $('app-screen').classList.remove('active', 'immersive');
    $('auth-screen').classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $('view-chats').classList.add('active');
    $('login-password').value = '';
    showLogin();
}

// ==================== APP START ====================
async function startApp(userId) {
    const { data: profile, error } = await sb.from('profiles').select('*').eq('id', userId).single();
    if (error || !profile) {
        console.error(error);
        toast('Profil introuvable — le SQL a-t-il bien été exécuté ?');
        await sb.auth.signOut();
        return;
    }
    me = profile;
    profiles.set(me.id, me);

    $('auth-screen').classList.remove('active');
    $('app-screen').classList.add('active');

    await refreshSocial();
    startRealtime();
    showView('chats');
    loadProfile();
    loadFriendRequests();
    loadStories();
}

// ==================== SOCIAL (amis + groupes) ====================
async function refreshSocial() {
    if (!me) return;
    const [fr, gr] = await Promise.all([
        sb.from('friendships').select('*').or(`requester.eq.${me.id},addressee.eq.${me.id}`),
        sb.from('groups').select('*, group_members(user_id)').order('created_at', { ascending: false })
    ]);
    if (fr.error) console.error('friendships', fr.error);
    if (gr.error) console.error('groups', gr.error);

    friendships = fr.data || [];
    groups = (gr.data || []).map(g => ({ ...g, members: (g.group_members || []).map(x => x.user_id) }));

    const ids = new Set();
    friendships.forEach(f => { ids.add(f.requester); ids.add(f.addressee); });
    groups.forEach(g => g.members.forEach(id => ids.add(id)));
    ids.delete(me.id);
    await fetchProfiles([...ids], true);

    friends = friendships
        .filter(f => f.status === 'accepted')
        .map(f => profiles.get(f.requester === me.id ? f.addressee : f.requester))
        .filter(Boolean);
}

function relationOf(userId) {
    const f = friendships.find(f =>
        (f.requester === me.id && f.addressee === userId) ||
        (f.requester === userId && f.addressee === me.id));
    if (!f) return { rel: 'none' };
    if (f.status === 'accepted') return { rel: 'friend', f };
    return { rel: f.requester === me.id ? 'sent' : 'received', f };
}

// ==================== REALTIME ====================
function startRealtime() {
    stopRealtime();

    realtimeChannel = sb.channel('flare-db-' + me.id)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, onNewMessage)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, onFriendshipChange)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_members' }, onGroupMemberAdded)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stories' }, () => {
            loadStories();
            if (activeView === 'discover') loadDiscoverFeed();
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'story_likes' }, onStoryLike)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'story_comments' }, onStoryComment)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'story_views' }, () => {
            if (activeView === 'profile') loadProfile();
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                // Après une coupure réseau : on rattrape ce qui a été manqué
                if (hasSubscribedOnce) resync();
                hasSubscribedOnce = true;
            }
        });

    presenceChannel = sb.channel('flare-presence', { config: { presence: { key: me.id } } });
    presenceChannel
        .on('presence', { event: 'sync' }, () => {
            onlineIds = new Set(Object.keys(presenceChannel.presenceState()));
            updateConvStatus();
            scheduleChatList();
        })
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                try { await presenceChannel.track({ at: Date.now() }); } catch (e) { console.error(e); }
            }
        });
}

function stopRealtime() {
    hasSubscribedOnce = false;
    if (!sb) return;
    if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
    if (presenceChannel) { sb.removeChannel(presenceChannel); presenceChannel = null; }
}

async function resync() {
    if (!me) return;
    await refreshSocial();
    loadFriendRequests();
    scheduleChatList();
    loadStories();
    if (currentChat && activeView === 'conversation') loadMessages();
}

async function onNewMessage(payload) {
    const m = payload.new;
    if (!m || !me) return;
    const key = keyOf(m);
    const inCurrent = currentChat && activeView === 'conversation' && chatKeyOf(currentChat) === key;

    if (m.sender_id !== me.id) await fetchProfiles([m.sender_id]);

    if (inCurrent) {
        appendMessage(m);
        markRead(key, ms(m.created_at));
    } else if (m.sender_id !== me.id) {
        const p = getProfile(m.sender_id);
        toast(`${p ? p.display_name : 'Nouveau message'} : ${m.kind === 'snap' ? '📸 Snap' : truncate(m.body, 30)}`);
    }
    scheduleChatList();
}

async function onFriendshipChange(payload) {
    if (!me) return;
    if (payload.eventType === 'DELETE' && !friendships.some(f => f.id === (payload.old && payload.old.id))) return;

    await refreshSocial();
    loadFriendRequests();
    scheduleChatList();
    if (activeView === 'profile') loadProfile();

    const row = payload.new && payload.new.id ? payload.new : null;
    if (!row) return;
    if (payload.eventType === 'INSERT' && row.addressee === me.id) {
        const p = getProfile(row.requester);
        toast(`Nouvelle demande d'ami de ${p ? p.display_name : 'quelqu\'un'}`);
    }
    if (payload.eventType === 'UPDATE' && row.status === 'accepted' && row.requester === me.id) {
        const p = getProfile(row.addressee);
        toast(`${p ? p.display_name : 'Quelqu\'un'} est maintenant ton ami 🔥`);
    }
}

async function onGroupMemberAdded(payload) {
    if (!me) return;
    await refreshSocial();
    scheduleChatList();
    if (payload.new && payload.new.user_id === me.id) {
        const g = groups.find(g => g.id === payload.new.group_id);
        if (g && g.created_by !== me.id) toast(`Tu as été ajouté au groupe « ${g.name} »`);
    }
}

async function onStoryLike(payload) {
    const l = payload.new;
    if (!l || !me || l.user_id === me.id) return;
    await fetchProfiles([l.user_id]);
    const p = getProfile(l.user_id);
    toast(`${p ? p.display_name : 'Quelqu\'un'} a aimé ta story ❤️`);
    if (activeView === 'profile') loadProfile();
}

async function onStoryComment(payload) {
    const c = payload.new;
    if (!c || !me || c.user_id === me.id) return;
    await fetchProfiles([c.user_id]);
    const p = getProfile(c.user_id);
    toast(`${p ? p.display_name : 'Quelqu\'un'} : ${truncate(c.body, 30)}`);
    if (activeView === 'profile') loadProfile();
}

// ==================== VIEW NAVIGATION ====================
function showView(viewName) {
    if (viewName !== 'camera') {
        if (activeView === 'camera') closeSnapPreview();
        stopCamera();
    }

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const view = $('view-' + viewName);
    if (view) {
        view.classList.add('active', 'fade-in');
        setTimeout(() => view.classList.remove('fade-in'), 200);
    }

    activeView = viewName;
    $('app-screen').classList.toggle('immersive', viewName === 'story-viewer');

    if (viewName !== 'conversation') {
        currentChat = null;
        $('emoji-picker').style.display = 'none';
    }
    if (viewName !== 'story-viewer') {
        clearTimeout(storyTimer);
        storyToken++;
    }

    // Barre de navigation
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const navMap = { chats: 0, conversation: 0, camera: 1, stories: 2, discover: 3 };
    const navBtns = document.querySelectorAll('.nav-btn');
    if (navMap[viewName] !== undefined && navBtns[navMap[viewName]]) navBtns[navMap[viewName]].classList.add('active');

    if (viewName === 'camera') startCamera();

    if (me) {
        if (viewName === 'chats') scheduleChatList();
        if (viewName === 'stories') loadStories();
        if (viewName === 'profile') loadProfile();
        if (viewName === 'new-group') loadGroupMembersList();
        if (viewName === 'add-friends') refreshSocial().then(loadFriendRequests);
        if (viewName === 'discover' && cleanQuery($('discover-search').value).length < 2) loadDiscoverFeed();
    }

    if (!['conversation', 'story-viewer', 'user-profile', 'edit-profile', 'settings', 'new-group'].includes(viewName)) {
        previousView = viewName;
    }
}

function goBack() { showView(previousView); }

// ==================== CAMERA ====================
async function startCamera() {
    try {
        if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
        torchOn = false;
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        if (activeView !== 'camera') { stopCamera(); return; }
        const video = $('camera-feed');
        video.muted = true;
        video.srcObject = cameraStream;
        video.play().catch(() => { });
    } catch (e) {
        console.error('Camera error:', e);
        toast(window.isSecureContext
            ? "Impossible d'accéder à la caméra (autorise-la dans le navigateur)"
            : 'La caméra demande HTTPS (ou localhost)');
    }
}

function stopCamera() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
}

function switchCamera() {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    startCamera();
}

function toggleFlash() {
    if (!cameraStream) return;
    const track = cameraStream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
        torchOn = !torchOn;
        track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => toast('Flash non disponible'));
    } else {
        toast('Flash non disponible');
    }
}

function captureSnap() {
    const video = $('camera-feed');
    if (!cameraStream || !video.videoWidth) return toast('Caméra pas encore prête');
    const canvas = $('camera-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(blob => {
        if (!blob) return toast('Capture impossible');
        setCaptured(blob, 'image');
    }, 'image/jpeg', 0.85);
}

async function handleSnapUpload(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
        const prepared = await prepareFile(file);
        if (prepared) setCaptured(prepared.blob, prepared.type);
    } catch (e) {
        console.error(e);
        toast('Fichier illisible');
    }
}

function setCaptured(blob, type) {
    if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    capturedBlob = blob;
    capturedType = type;
    capturedUrl = URL.createObjectURL(blob);
    showSnapPreview();
}

function showSnapPreview() {
    $('snap-preview').style.display = 'flex';
    const img = $('snap-preview-img');
    const vid = $('snap-preview-vid');
    if (capturedType === 'image') {
        img.src = capturedUrl;
        img.style.display = 'block';
        vid.pause();
        vid.style.display = 'none';
    } else {
        vid.src = capturedUrl;
        vid.style.display = 'block';
        vid.play().catch(() => { });
        img.style.display = 'none';
    }
}

function closeSnapPreview() {
    $('snap-preview').style.display = 'none';
    $('send-snap-modal').style.display = 'none';
    const vid = $('snap-preview-vid');
    vid.pause();
    vid.removeAttribute('src');
    $('snap-preview-img').removeAttribute('src');
    if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    capturedUrl = null;
    capturedBlob = null;
    capturedType = null;
}

function addSnapText() { toast('Texte (bientôt disponible)'); }
function addSnapSticker() { toast('Stickers (bientôt disponible)'); }

// ==================== ENVOI D'UN SNAP ====================
function openSendSnapTo() {
    if (!capturedBlob) return;
    $('send-snap-modal').style.display = 'flex';
    const list = $('send-snap-list');
    list.innerHTML = '';

    friends.forEach(u => {
        const item = document.createElement('div');
        item.className = 'send-item';
        item.dataset.type = 'dm';
        item.dataset.id = u.id;
        item.innerHTML = `
            <div class="chat-avatar">${avatarInner(u)}</div>
            <div class="send-name">${esc(u.display_name)}</div>
            <div class="send-check"><i class="fas fa-check"></i></div>`;
        item.onclick = () => item.classList.toggle('selected');
        list.appendChild(item);
    });

    groups.forEach(g => {
        const item = document.createElement('div');
        item.className = 'send-item';
        item.dataset.type = 'group';
        item.dataset.id = g.id;
        item.innerHTML = `
            <div class="chat-avatar" style="background:var(--gradient2)">${g.photo_url ? `<img src="${esc(g.photo_url)}" alt="">` : '<i class="fas fa-users" style="font-size:18px;color:#333"></i>'}</div>
            <div class="send-name">👥 ${esc(g.name)}</div>
            <div class="send-check"><i class="fas fa-check"></i></div>`;
        item.onclick = () => item.classList.toggle('selected');
        list.appendChild(item);
    });

    if (!friends.length && !groups.length) {
        list.innerHTML = '<div class="empty-state" style="padding:30px 20px"><i class="fas fa-user-friends"></i><p>Ajoute d\'abord des amis</p></div>';
        return;
    }

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-primary';
    confirmBtn.style.margin = '16px';
    confirmBtn.textContent = 'Envoyer le Snap';
    confirmBtn.onclick = sendSnapToSelected;
    list.appendChild(confirmBtn);
}

function closeSendSnapTo() { $('send-snap-modal').style.display = 'none'; }

async function sendSnapToSelected() {
    const selected = [...document.querySelectorAll('#send-snap-list .send-item.selected')];
    if (!selected.length) return toast('Sélectionne au moins un destinataire');
    if (!capturedBlob || busy) return;

    setBusy(true);
    toast('Envoi en cours…');
    try {
        const ext = capturedType === 'video' ? extFromType(capturedBlob.type) : 'jpg';
        const url = await uploadMedia(capturedBlob, ext);
        const rows = selected.map(el => ({
            sender_id: me.id,
            kind: 'snap',
            body: null,
            media_url: url,
            media_type: capturedType,
            recipient_id: el.dataset.type === 'dm' ? el.dataset.id : null,
            group_id: el.dataset.type === 'group' ? el.dataset.id : null
        }));
        const { error } = await sb.from('messages').insert(rows);
        if (error) throw error;
        closeSnapPreview();
        toast('Snap envoyé 🔥');
        scheduleChatList();
    } catch (e) {
        console.error(e);
        toast('Échec de l\'envoi : ' + errMsg(e));
    } finally {
        setBusy(false);
    }
}

// ==================== STORIES ====================
async function saveToStory() {
    if (!capturedBlob || busy) return;
    setBusy(true);
    toast('Publication…');
    try {
        const ext = capturedType === 'video' ? extFromType(capturedBlob.type) : 'jpg';
        const url = await uploadMedia(capturedBlob, ext, 'story');
        const { error } = await sb.from('stories').insert({ user_id: me.id, media_url: url, media_type: capturedType });
        if (error) throw error;
        closeSnapPreview();
        toast('Story publiée 🔥');
        loadStories();
    } catch (e) {
        console.error(e);
        toast('Échec de la publication : ' + errMsg(e));
    } finally {
        setBusy(false);
    }
}

async function fetchActiveStories(filterFn) {
    const since = new Date(Date.now() - DAY_MS).toISOString();
    let q = sb.from('stories').select('*').gte('created_at', since).order('created_at', { ascending: true });
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) { console.error('stories', error); return []; }
    return data || [];
}

function storyItemHTML(p, arr, allSeen) {
    const last = arr[arr.length - 1];
    return `
        <div class="story-avatar ${allSeen ? 'no-story' : ''}">${avatarInner(p)}</div>
        <div class="story-info">
            <div class="story-name">${esc(p.display_name)}</div>
            <div class="story-time">${getTimeAgo(last.created_at)}</div>
        </div>`;
}

async function loadStories() {
    if (!me) return;
    const list = await fetchActiveStories();
    await fetchProfiles([...new Set(list.map(s => s.user_id))]);

    let seen = new Set();
    if (list.length) {
        const { data: v } = await sb.from('story_views').select('story_id').eq('viewer_id', me.id).in('story_id', list.map(s => s.id));
        seen = new Set((v || []).map(x => x.story_id));
    }

    const byUser = new Map();
    list.forEach(s => {
        if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
        byUser.get(s.user_id).push(s);
    });

    const fBox = $('friends-stories');
    const dBox = $('discover-stories');
    fBox.innerHTML = "<h3>Stories d'amis</h3>";
    dBox.innerHTML = '<h3>Découvrir</h3>';
    const friendIds = new Set(friends.map(f => f.id));
    let nf = 0, nd = 0;

    [...byUser.entries()]
        .sort((a, b) => ms(b[1][b[1].length - 1].created_at) - ms(a[1][a[1].length - 1].created_at))
        .forEach(([uid, arr]) => {
            if (uid === me.id) return;
            const p = profiles.get(uid);
            if (!p) return;
            const isFriend = friendIds.has(uid);
            const item = document.createElement('div');
            item.className = 'story-item';
            item.innerHTML = storyItemHTML(p, arr, arr.every(s => seen.has(s.id)));
            item.onclick = () => openStoryViewer(uid, arr);
            (isFriend ? fBox : dBox).appendChild(item);
            isFriend ? nf++ : nd++;
        });

    if (!nf) fBox.insertAdjacentHTML('beforeend', '<p class="hint">Aucune story d\'ami pour le moment</p>');
    if (!nd) dBox.insertAdjacentHTML('beforeend', '<p class="hint">Rien à découvrir pour le moment</p>');

    const mine = byUser.get(me.id) || [];
    const av = document.querySelector('.my-story .story-avatar');
    if (av) av.style.borderStyle = mine.length ? 'solid' : 'dashed';
}

async function openStoryViewer(userId, stories) {
    if (!stories || !stories.length) return;
    storyReturnView = activeView === 'story-viewer' ? storyReturnView : activeView;
    viewingStories = stories.map(s => ({ ...s }));
    currentStoryIndex = 0;

    // Quels likes ai-je déjà donnés ?
    const { data: likes } = await sb.from('story_likes').select('story_id').eq('user_id', me.id).in('story_id', viewingStories.map(s => s.id));
    const liked = new Set((likes || []).map(l => l.story_id));
    viewingStories.forEach(s => { s.liked = liked.has(s.id); });

    await fetchProfiles([userId]);
    const p = getProfile(userId);
    $('sv-avatar').innerHTML = avatarInner(p);
    $('sv-name').textContent = p ? p.display_name : '';

    showView('story-viewer');
    displayCurrentStory();
}

function renderLikeBtn(story) {
    const btn = $('story-like-btn');
    btn.classList.toggle('liked', !!story.liked);
    btn.innerHTML = story.liked ? '<i class="fas fa-heart"></i>' : '<i class="far fa-heart"></i>';
}

function activeFill() {
    return document.querySelector('#story-progress .progress-bar.active .fill');
}

function startStoryTimer(msDuration) {
    clearTimeout(storyTimer);
    storyDuration = msDuration;
    storyElapsed = 0;
    storyStartedAt = Date.now();
    const fill = activeFill();
    if (fill) {
        fill.style.animationDuration = msDuration + 'ms';
        fill.style.animationPlayState = 'running';
    }
    const token = storyToken;
    storyTimer = setTimeout(() => { if (token === storyToken) nextStory(); }, msDuration);
}

function pauseStory() {
    if (activeView !== 'story-viewer' || !storyTimer) return;
    clearTimeout(storyTimer);
    storyTimer = null;
    storyElapsed += Date.now() - storyStartedAt;
    const fill = activeFill();
    if (fill) fill.style.animationPlayState = 'paused';
}

function resumeStory() {
    if (activeView !== 'story-viewer' || storyTimer) return;
    const remaining = Math.max(300, storyDuration - storyElapsed);
    storyStartedAt = Date.now();
    const fill = activeFill();
    if (fill) fill.style.animationPlayState = 'running';
    const token = storyToken;
    storyTimer = setTimeout(() => { if (token === storyToken) nextStory(); }, remaining);
}

function nextStory() {
    currentStoryIndex++;
    displayCurrentStory();
}

function prevStory() {
    if (currentStoryIndex > 0) currentStoryIndex--;
    displayCurrentStory();
}

function recordStoryView(story) {
    if (story.user_id === me.id || story._viewed) return;
    story._viewed = true;
    sb.from('story_views')
        .upsert({ story_id: story.id, viewer_id: me.id }, { onConflict: 'story_id,viewer_id', ignoreDuplicates: true })
        .then(({ error }) => { if (error) console.error('story view', error); });
}

function displayCurrentStory() {
    if (currentStoryIndex >= viewingStories.length) return closeStoryViewer();
    const story = viewingStories[currentStoryIndex];
    const token = ++storyToken;

    $('sv-time').textContent = getTimeAgo(story.created_at);
    recordStoryView(story);

    const content = $('story-viewer-content');
    content.innerHTML = '';
    let defaultMs = 5000;

    if (story.media_type === 'video') {
        const v = document.createElement('video');
        v.src = story.media_url;
        v.autoplay = true;
        v.loop = true;
        v.playsInline = true;
        v.onloadedmetadata = () => {
            if (token !== storyToken || !isFinite(v.duration)) return;
            startStoryTimer(Math.min(Math.max(v.duration * 1000, 3000), 30000));
        };
        content.appendChild(v);
        v.play().catch(() => { v.muted = true; v.play().catch(() => { }); });
        defaultMs = 15000;
    } else {
        const img = document.createElement('img');
        img.src = story.media_url;
        content.appendChild(img);
    }

    const progress = $('story-progress');
    progress.innerHTML = '';
    viewingStories.forEach((_, i) => {
        const bar = document.createElement('div');
        bar.className = 'progress-bar' + (i < currentStoryIndex ? ' done' : i === currentStoryIndex ? ' active' : '');
        bar.innerHTML = '<div class="fill"></div>';
        progress.appendChild(bar);
    });

    renderLikeBtn(story);
    startStoryTimer(defaultMs);

    content.onclick = (e) => {
        const rect = content.getBoundingClientRect();
        if (e.clientX - rect.left < rect.width / 3) prevStory();
        else nextStory();
    };
}

function closeStoryViewer() {
    clearTimeout(storyTimer);
    storyToken++;
    const back = storyReturnView && storyReturnView !== 'story-viewer' ? storyReturnView : 'stories';
    showView(back);
}

async function likeStory() {
    const story = viewingStories[currentStoryIndex];
    if (!story || likeBusy) return;
    likeBusy = true;
    const wasLiked = !!story.liked;
    story.liked = !wasLiked;
    renderLikeBtn(story);

    const res = wasLiked
        ? await sb.from('story_likes').delete().eq('story_id', story.id).eq('user_id', me.id)
        : await sb.from('story_likes').insert({ story_id: story.id, user_id: me.id });

    if (res.error) {
        console.error(res.error);
        story.liked = wasLiked;
        renderLikeBtn(story);
        toast('Impossible de liker : ' + errMsg(res.error));
    }
    likeBusy = false;
}

async function postStoryComment(text) {
    const story = viewingStories[currentStoryIndex];
    if (!story) return false;
    const { error } = await sb.from('story_comments').insert({ story_id: story.id, user_id: me.id, body: text.slice(0, 500) });
    if (error) {
        console.error(error);
        toast("Échec de l'envoi : " + errMsg(error));
        return false;
    }
    return true;
}

async function replyToStory() {
    const input = $('story-reply-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (await postStoryComment(text)) toast('Réponse envoyée');
    else input.value = text;
}

async function reactStory() {
    if (await postStoryComment('😮')) toast('Réaction envoyée 😮');
}

// ==================== CHAT LIST ====================
function scheduleChatList() {
    clearTimeout(chatListTimer);
    chatListTimer = setTimeout(loadChatList, 120);
}

async function loadChatList() {
    if (!me) return;
    const seq = ++chatListSeq;
    const { data, error } = await sb.from('messages')
        .select('id,sender_id,recipient_id,group_id,kind,body,created_at')
        .order('created_at', { ascending: false })
        .limit(500);
    if (seq !== chatListSeq || !me) return;
    if (error) console.error('chat list', error);

    const byChat = {};
    (data || []).forEach(m => {
        const key = keyOf(m);
        const entry = byChat[key] || (byChat[key] = { last: m, unread: 0 });
        if (m.sender_id !== me.id && ms(m.created_at) > getLastRead(key)) entry.unread++;
    });

    const preview = (m, fallback) => {
        if (!m) return fallback;
        const txt = m.kind === 'snap' ? '📸 Snap' : m.body;
        return (m.sender_id === me.id ? 'Toi : ' : '') + txt;
    };

    const items = [];
    friends.forEach(u => {
        const e = byChat['dm:' + u.id];
        items.push({
            type: 'dm', id: u.id, name: u.display_name, avatar: avatarInner(u),
            last: preview(e && e.last, 'Commence une conversation'),
            time: e ? ms(e.last.created_at) : 0,
            unread: e ? e.unread : 0,
            online: onlineIds.has(u.id)
        });
    });
    groups.forEach(g => {
        const e = byChat['grp:' + g.id];
        items.push({
            type: 'group', id: g.id, name: g.name, isGroup: true,
            avatar: g.photo_url ? `<img src="${esc(g.photo_url)}" alt="">` : '<i class="fas fa-users" style="font-size:20px;color:#333"></i>',
            last: preview(e && e.last, 'Nouveau groupe'),
            time: e ? ms(e.last.created_at) : ms(g.created_at),
            unread: e ? e.unread : 0
        });
    });
    items.sort((a, b) => b.time - a.time);

    const list = $('chat-list');
    list.innerHTML = '';
    if (!items.length) {
        list.innerHTML = `<div class="empty-state"><i class="fas fa-comments"></i><p>Aucun message</p><p class="sub">Ajoute des amis pour commencer !</p></div>`;
        return;
    }

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'chat-item';
        div.innerHTML = `
            <div class="chat-avatar">${item.avatar}${item.online ? '<div class="online-dot"></div>' : ''}</div>
            <div class="chat-info">
                <div class="chat-name">${item.isGroup ? '<i class="fas fa-users group-icon"></i> ' : ''}${esc(item.name)}</div>
                <div class="chat-last-msg">${esc(item.last)}</div>
            </div>
            <div class="chat-meta">
                <div class="chat-time">${item.time ? formatTime(item.time) : ''}</div>
                ${item.unread > 0 ? `<div class="chat-unread">${item.unread}</div>` : ''}
            </div>`;
        div.addEventListener('click', () => openChat(item.type, item.id));
        list.appendChild(div);
    });
}

// ==================== CONVERSATION ====================
async function openChat(type, id) {
    let name, photo, isGroup = type === 'group';
    if (isGroup) {
        const g = groups.find(g => g.id === id);
        if (!g) return toast('Groupe introuvable');
        name = g.name; photo = g.photo_url;
    } else {
        await fetchProfiles([id]);
        const p = profiles.get(id);
        if (!p) return toast('Utilisateur introuvable');
        name = p.display_name; photo = p.photo_url;
    }

    currentChat = { type, id };
    $('conv-name').textContent = name;
    $('conv-avatar').innerHTML = photo ? `<img src="${esc(photo)}" alt="">` : (isGroup ? '<i class="fas fa-users" style="color:#333"></i>' : esc(initial(name)));
    updateConvStatus();

    showView('conversation');   // showView remet currentChat à null sauf pour 'conversation'
    await loadMessages();
}

function updateConvStatus() {
    if (!currentChat) return;
    const el = $('conv-status');
    if (currentChat.type === 'group') {
        const g = groups.find(g => g.id === currentChat.id);
        el.textContent = `${g ? g.members.length : 0} membres`;
        el.classList.remove('offline');
    } else {
        const on = onlineIds.has(currentChat.id);
        el.textContent = on ? 'En ligne' : 'Hors ligne';
        el.classList.toggle('offline', !on);
    }
}

async function loadMessages() {
    const chat = currentChat;
    if (!chat) return;
    const container = $('conv-messages');

    let q = sb.from('messages').select('*').order('created_at', { ascending: true }).limit(300);
    q = chat.type === 'group'
        ? q.eq('group_id', chat.id)
        : q.or(`and(sender_id.eq.${me.id},recipient_id.eq.${chat.id}),and(sender_id.eq.${chat.id},recipient_id.eq.${me.id})`);

    const { data, error } = await q;
    if (currentChat !== chat) return;    // l'utilisateur a changé de conversation entre-temps
    if (error) { console.error(error); return toast('Impossible de charger les messages'); }

    await fetchProfiles((data || []).map(m => m.sender_id));
    if (currentChat !== chat) return;

    container.innerHTML = '';
    renderedIds = new Set();
    (data || []).forEach(m => appendMessage(m, false));
    container.scrollTop = container.scrollHeight;

    if (data && data.length) markRead(chatKeyOf(chat), ms(data[data.length - 1].created_at));
    scheduleChatList();
}

function appendMessage(m, scroll = true) {
    const container = $('conv-messages');
    if (!container || renderedIds.has(m.id)) return;
    renderedIds.add(m.id);

    const isMe = m.sender_id === me.id;
    const div = document.createElement('div');
    div.className = `msg ${isMe ? 'sent' : 'received'}`;

    if (currentChat && currentChat.type === 'group' && !isMe) {
        const p = getProfile(m.sender_id);
        const s = document.createElement('div');
        s.className = 'msg-sender';
        s.textContent = p ? p.display_name : '?';
        div.appendChild(s);
    }

    if (m.kind === 'snap') {
        div.classList.add('snap-msg');
        if (m.media_type === 'video') {
            const v = document.createElement('video');
            v.src = m.media_url;
            v.controls = true;
            v.playsInline = true;
            v.preload = 'metadata';
            div.appendChild(v);
        } else {
            const img = document.createElement('img');
            img.src = m.media_url;
            img.loading = 'lazy';
            img.onclick = () => window.open(m.media_url, '_blank');
            div.appendChild(img);
        }
        const label = document.createElement('div');
        label.className = 'snap-label';
        label.innerHTML = '<i class="fas fa-bolt"></i> Snap';
        div.appendChild(label);
    } else {
        const t = document.createElement('span');
        t.textContent = m.body;
        div.appendChild(t);
    }

    const timeDiv = document.createElement('div');
    timeDiv.className = 'msg-time';
    timeDiv.textContent = formatTime(m.created_at);
    div.appendChild(timeDiv);

    container.appendChild(div);
    if (scroll) container.scrollTop = container.scrollHeight;
}

function messageRow(extra) {
    return {
        sender_id: me.id,
        recipient_id: currentChat.type === 'dm' ? currentChat.id : null,
        group_id: currentChat.type === 'group' ? currentChat.id : null,
        ...extra
    };
}

async function sendMessage() {
    const input = $('conv-input');
    const text = input.value.trim();
    if (!text || !currentChat) return;
    input.value = '';
    const chat = currentChat;

    const { data, error } = await sb.from('messages')
        .insert(messageRow({ kind: 'text', body: text }))
        .select().single();

    if (error) {
        console.error(error);
        input.value = text;
        return toast('Message non envoyé : ' + errMsg(error));
    }
    if (currentChat === chat) {
        appendMessage(data);
        markRead(chatKeyOf(chat), ms(data.created_at));
    }
    scheduleChatList();
}

function openSnapInConv() {
    if (!currentChat) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file || busy) return;
        const chat = currentChat;
        setBusy(true);
        toast('Envoi en cours…');
        try {
            const prepared = await prepareFile(file);
            if (!prepared) return;
            const ext = prepared.type === 'video' ? extFromType(prepared.blob.type) : 'jpg';
            const url = await uploadMedia(prepared.blob, ext);
            const { data, error } = await sb.from('messages')
                .insert({
                    sender_id: me.id,
                    recipient_id: chat.type === 'dm' ? chat.id : null,
                    group_id: chat.type === 'group' ? chat.id : null,
                    kind: 'snap', media_url: url, media_type: prepared.type
                })
                .select().single();
            if (error) throw error;
            if (currentChat === chat) appendMessage(data);
            scheduleChatList();
            toast('Snap envoyé 🔥');
        } catch (err) {
            console.error(err);
            toast("Échec de l'envoi : " + errMsg(err));
        } finally {
            setBusy(false);
        }
    };
    input.click();
}

function startCall(type) { toast(`Appel ${type === 'video' ? 'vidéo' : 'audio'} bientôt disponible`); }

function showConvInfo() {
    if (!currentChat) return;
    if (currentChat.type === 'group') {
        const g = groups.find(g => g.id === currentChat.id);
        if (!g) return;
        const names = g.members.map(id => (getProfile(id) || {}).display_name).filter(Boolean);
        toast('Membres : ' + truncate(names.join(', '), 80));
    } else {
        showUserProfile(currentChat.id);
    }
}

// ==================== PROFILE ====================
async function loadProfile() {
    if (!me) return;
    $('profile-display-name').textContent = me.display_name;
    $('profile-username').textContent = '@' + me.username;
    $('profile-bio').textContent = me.bio || '';
    $('profile-avatar').innerHTML = avatarInner(me);
    $('stat-friends').textContent = friends.length;

    const [snaps, views, mine] = await Promise.all([
        sb.from('messages').select('id', { count: 'exact', head: true }).eq('sender_id', me.id).eq('kind', 'snap'),
        // grâce aux règles de sécurité, on ne voit que : mes propres vues (exclues ici) + les vues de MES stories
        sb.from('story_views').select('story_id', { count: 'exact', head: true }).neq('viewer_id', me.id),
        fetchActiveStories(q => q.eq('user_id', me.id))
    ]);
    if (!me) return;
    $('stat-snaps').textContent = snaps.count || 0;
    $('stat-views').textContent = views.count || 0;

    const list = $('my-stories-list');
    list.innerHTML = '';
    if (!mine.length) {
        list.innerHTML = '<p class="hint">Aucune story active</p>';
        return;
    }

    const ids = mine.map(s => s.id);
    const [v, l, c] = await Promise.all([
        sb.from('story_views').select('story_id').in('story_id', ids).neq('viewer_id', me.id),
        sb.from('story_likes').select('story_id').in('story_id', ids),
        sb.from('story_comments').select('story_id').in('story_id', ids)
    ]);
    const count = (res, id) => (res.data || []).filter(x => x.story_id === id).length;

    list.innerHTML = '';
    mine.slice().reverse().forEach(s => {
        const div = document.createElement('div');
        div.className = 'story-item';
        const thumb = s.media_type === 'video'
            ? `<video class="story-thumb" src="${esc(s.media_url)}" muted playsinline preload="metadata"></video>`
            : `<img class="story-thumb" src="${esc(s.media_url)}" alt="">`;
        div.innerHTML = `${thumb}
            <div class="story-info">
                <div class="story-name">Ma Story</div>
                <div class="story-time">${getTimeAgo(s.created_at)} · ${count(v, s.id)} vues · ${count(l, s.id)} ❤️ · ${count(c, s.id)} 💬</div>
            </div>`;
        div.onclick = () => openStoryViewer(me.id, mine);
        list.appendChild(div);
    });
}

function changeProfilePhoto() { $('profile-photo-input').click(); }

async function handleProfilePhoto(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || busy) return;
    setBusy(true);
    try {
        const blob = await compressImage(file, 256, 0.8, true);
        const url = await uploadMedia(blob, 'jpg', 'avatar');
        const { data, error } = await sb.from('profiles').update({ photo_url: url }).eq('id', me.id).select().single();
        if (error) throw error;
        me = data;
        profiles.set(me.id, me);
        loadProfile();
        toast('Photo de profil mise à jour');
    } catch (e) {
        console.error(e);
        toast('Échec : ' + errMsg(e));
    } finally {
        setBusy(false);
    }
}

function editProfile() {
    $('edit-display-name').value = me.display_name;
    $('edit-bio').value = me.bio || '';
    showView('edit-profile');
}

async function saveProfile() {
    const display = $('edit-display-name').value.trim().slice(0, 40);
    const bio = $('edit-bio').value.trim().slice(0, 200);
    if (!display) return toast('Le nom est requis');
    if (busy) return;

    setBusy(true);
    try {
        const { data, error } = await sb.from('profiles').update({ display_name: display, bio }).eq('id', me.id).select().single();
        if (error) throw error;
        me = data;
        profiles.set(me.id, me);
        showView('profile');
        toast('Profil mis à jour');
    } catch (e) {
        console.error(e);
        toast('Échec : ' + errMsg(e));
    } finally {
        setBusy(false);
    }
}

function showSettings() { showView('settings'); }

// ==================== AMIS ====================
function userRow(u, { withProfileClick = false } = {}) {
    const div = document.createElement('div');
    div.className = 'friend-result';
    div.innerHTML = `
        <div class="chat-avatar">${avatarInner(u)}</div>
        <div class="friend-info">
            <div class="friend-name">${esc(u.display_name)}</div>
            <div class="friend-username">@${esc(u.username)}</div>
        </div>`;
    div.appendChild(makeRelationButton(u));
    if (withProfileClick) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => showUserProfile(u.id));
    }
    return div;
}

function makeRelationButton(u) {
    const { rel, f } = relationOf(u.id);
    const btn = document.createElement('button');
    btn.className = 'add-friend-btn';

    if (rel === 'friend') { btn.textContent = '✓ Ami'; btn.classList.add('added'); btn.disabled = true; }
    else if (rel === 'sent') { btn.textContent = 'Envoyé'; btn.classList.add('added'); btn.disabled = true; }
    else if (rel === 'received') {
        btn.textContent = 'Accepter';
        btn.onclick = async (e) => { e.stopPropagation(); await acceptFriend(f.id); btn.replaceWith(makeRelationButton(u)); };
    } else {
        btn.textContent = '+ Ajouter';
        btn.onclick = async (e) => { e.stopPropagation(); await sendFriendRequest(u.id); btn.replaceWith(makeRelationButton(u)); };
    }
    return btn;
}

async function findProfiles(q) {
    const c = cleanQuery(q);
    if (c.length < 2) return null;
    const { data, error } = await sb.from('profiles').select('*')
        .or(`username.ilike.%${c}%,display_name.ilike.%${c}%`)
        .neq('id', me.id).limit(20);
    if (error) { console.error(error); return []; }
    (data || []).forEach(p => profiles.set(p.id, p));
    return data || [];
}

let friendSearchSeq = 0;
const searchFriends = debounce(async (query) => {
    const container = $('friend-results');
    const seq = ++friendSearchSeq;
    const results = await findProfiles(query);
    if (seq !== friendSearchSeq) return;

    if (results === null) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-user-friends"></i><p>Cherche des amis par nom d'utilisateur</p></div>`;
        return;
    }
    container.innerHTML = '';
    if (!results.length) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>Aucun résultat</p></div>`;
        return;
    }
    results.forEach(u => container.appendChild(userRow(u, { withProfileClick: true })));
}, 250);

let discoverSearchSeq = 0;
const searchUsers = debounce(async (query) => {
    const container = $('discover-content');
    const seq = ++discoverSearchSeq;
    const results = await findProfiles(query);
    if (seq !== discoverSearchSeq) return;

    if (results === null) return loadDiscoverFeed();
    container.innerHTML = '';
    if (!results.length) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>Aucun résultat</p></div>`;
        return;
    }
    results.forEach(u => container.appendChild(userRow(u, { withProfileClick: true })));
}, 250);

async function sendFriendRequest(userId) {
    if (relationOf(userId).rel !== 'none') return toast('Déjà en relation');
    const { error } = await sb.from('friendships').insert({ requester: me.id, addressee: userId, status: 'pending' });
    if (error) {
        console.error(error);
        return toast(error.code === '23505' ? 'Demande déjà envoyée' : "Échec de l'envoi : " + errMsg(error));
    }
    await refreshSocial();
    const p = profiles.get(userId);
    toast('Demande envoyée à @' + (p ? p.username : ''));
}

function loadFriendRequests() {
    const container = $('friend-requests');
    if (!container || !me) return;
    const requests = friendships.filter(f => f.status === 'pending' && f.addressee === me.id);
    container.innerHTML = '';
    if (!requests.length) {
        container.innerHTML = '<p class="hint">Aucune demande</p>';
        return;
    }
    requests.forEach(req => {
        const u = profiles.get(req.requester);
        if (!u) return;
        const div = document.createElement('div');
        div.className = 'friend-request';
        div.innerHTML = `
            <div class="chat-avatar">${avatarInner(u)}</div>
            <div class="fr-info"><div class="fr-name">${esc(u.display_name)}</div></div>
            <div class="fr-actions">
                <button class="fr-accept">Accepter</button>
                <button class="fr-decline">Refuser</button>
            </div>`;
        div.querySelector('.fr-accept').onclick = () => acceptFriend(req.id);
        div.querySelector('.fr-decline').onclick = () => declineFriend(req.id);
        container.appendChild(div);
    });
}

async function acceptFriend(friendshipId) {
    const { error } = await sb.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId).eq('addressee', me.id);
    if (error) { console.error(error); return toast('Échec : ' + errMsg(error)); }
    await refreshSocial();
    loadFriendRequests();
    scheduleChatList();
    toast('Vous êtes maintenant amis 🔥');
}

async function declineFriend(friendshipId) {
    const { error } = await sb.from('friendships').delete().eq('id', friendshipId);
    if (error) { console.error(error); return toast('Échec : ' + errMsg(error)); }
    await refreshSocial();
    loadFriendRequests();
}

// ==================== GROUPES ====================
function loadGroupMembersList() {
    const list = $('group-members-list');
    list.innerHTML = '';
    selectedGroupMembers = new Set();

    if (!friends.length) {
        list.innerHTML = '<p class="hint">Ajoute d\'abord des amis pour créer un groupe</p>';
        return;
    }
    friends.forEach(u => {
        const div = document.createElement('div');
        div.className = 'member-select-item';
        div.innerHTML = `
            <div class="chat-avatar">${avatarInner(u)}</div>
            <div class="ms-name">${esc(u.display_name)}</div>
            <div class="ms-check"><i class="fas fa-check"></i></div>`;
        div.onclick = () => {
            div.classList.toggle('selected');
            if (selectedGroupMembers.has(u.id)) selectedGroupMembers.delete(u.id);
            else selectedGroupMembers.add(u.id);
        };
        list.appendChild(div);
    });
}

async function handleGroupPhoto(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
        groupPhotoBlob = await compressImage(file, 256, 0.8, true);
        const url = URL.createObjectURL(groupPhotoBlob);
        $('group-photo-preview').innerHTML = `<img src="${url}" alt="">`;
    } catch (e) {
        console.error(e);
        toast('Image illisible');
    }
}

async function createGroup() {
    const name = $('group-name').value.trim().slice(0, 40);
    if (!name) return toast('Donne un nom au groupe');
    if (!selectedGroupMembers.size) return toast('Ajoute au moins un membre');
    if (busy) return;

    setBusy(true);
    try {
        let photoUrl = null;
        if (groupPhotoBlob) photoUrl = await uploadMedia(groupPhotoBlob, 'jpg', 'group');

        const { data: g, error } = await sb.from('groups')
            .insert({ name, photo_url: photoUrl, created_by: me.id })
            .select().single();
        if (error) throw error;

        const members = [me.id, ...selectedGroupMembers].map(user_id => ({ group_id: g.id, user_id }));
        const { error: e2 } = await sb.from('group_members').insert(members);
        if (e2) throw e2;

        $('group-name').value = '';
        $('group-photo-preview').innerHTML = groupPhotoDefaultHTML;
        groupPhotoBlob = null;
        selectedGroupMembers = new Set();

        await refreshSocial();
        showView('chats');
        toast('Groupe créé ! 🔥');
    } catch (e) {
        console.error(e);
        toast('Échec : ' + errMsg(e));
    } finally {
        setBusy(false);
    }
}

// ==================== PROFIL D'UN AUTRE UTILISATEUR ====================
async function showUserProfile(userId) {
    if (userId === me.id) return showView('profile');
    await fetchProfiles([userId]);
    const u = profiles.get(userId);
    if (!u) return toast('Utilisateur introuvable');

    $('user-profile-display').textContent = u.display_name;
    $('user-profile-username').textContent = '@' + u.username;
    $('user-profile-bio').textContent = u.bio || '';
    $('user-profile-avatar').innerHTML = avatarInner(u);

    const actions = $('user-profile-actions');
    actions.innerHTML = '';
    const { rel, f } = relationOf(userId);
    const btn = document.createElement('button');
    if (rel === 'friend') {
        btn.className = 'btn-secondary';
        btn.innerHTML = '<i class="fas fa-comment"></i> Message';
        btn.onclick = () => openChat('dm', userId);
    } else if (rel === 'sent') {
        btn.className = 'btn-secondary';
        btn.textContent = 'Demande envoyée';
        btn.disabled = true;
    } else if (rel === 'received') {
        btn.className = 'btn-primary';
        btn.style.display = 'inline-block';
        btn.textContent = 'Accepter la demande';
        btn.onclick = async () => { await acceptFriend(f.id); showUserProfile(userId); };
    } else {
        btn.className = 'btn-primary';
        btn.style.display = 'inline-block';
        btn.textContent = '+ Ajouter';
        btn.onclick = async () => { await sendFriendRequest(userId); showUserProfile(userId); };
    }
    actions.appendChild(btn);

    showView('user-profile');

    const list = $('user-stories-list');
    list.innerHTML = '<p class="hint">Chargement…</p>';
    const stories = await fetchActiveStories(q => q.eq('user_id', userId));
    if (activeView !== 'user-profile') return;
    list.innerHTML = '';
    if (!stories.length) {
        list.innerHTML = '<p class="hint">Aucune story active</p>';
        return;
    }
    stories.slice().reverse().forEach(s => {
        const div = document.createElement('div');
        div.className = 'story-item';
        const thumb = s.media_type === 'video'
            ? `<video class="story-thumb" src="${esc(s.media_url)}" muted playsinline preload="metadata"></video>`
            : `<img class="story-thumb" src="${esc(s.media_url)}" alt="">`;
        div.innerHTML = `${thumb}
            <div class="story-info">
                <div class="story-name">Story</div>
                <div class="story-time">${getTimeAgo(s.created_at)}</div>
            </div>`;
        div.onclick = () => openStoryViewer(userId, stories);
        list.appendChild(div);
    });
}

// ==================== DÉCOUVRIR ====================
async function loadDiscoverFeed() {
    if (!me) return;
    const container = $('discover-content');
    const stories = await fetchActiveStories(q => q.neq('user_id', me.id));
    if (activeView !== 'discover' || cleanQuery($('discover-search').value).length >= 2) return;

    await fetchProfiles(stories.map(s => s.user_id));
    const byUser = new Map();
    stories.forEach(s => {
        if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
        byUser.get(s.user_id).push(s);
    });

    container.innerHTML = '';
    [...byUser.entries()]
        .sort((a, b) => ms(b[1][b[1].length - 1].created_at) - ms(a[1][a[1].length - 1].created_at))
        .forEach(([uid, arr]) => {
            const u = profiles.get(uid);
            if (!u) return;
            const latest = arr[arr.length - 1];
            const card = document.createElement('div');
            card.className = 'discover-card';
            const media = latest.media_type === 'video'
                ? `<video src="${esc(latest.media_url)}" muted playsinline preload="metadata"></video>`
                : `<img src="${esc(latest.media_url)}" alt="" loading="lazy">`;
            card.innerHTML = `${media}
                <div class="discover-card-info">
                    <h4>${esc(u.display_name)}</h4>
                    <p>@${esc(u.username)}</p>
                    <div class="discover-card-stats">
                        <span><i class="fas fa-clock"></i> ${getTimeAgo(latest.created_at)}</span>
                        <span><i class="fas fa-images"></i> ${arr.length} story${arr.length > 1 ? 's' : ''}</span>
                    </div>
                </div>`;
            card.onclick = () => openStoryViewer(uid, arr);
            container.appendChild(card);
        });

    if (!container.children.length) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-compass"></i><p>Rien à découvrir pour le moment</p><p class="sub">Cherche des utilisateurs ci-dessus</p></div>`;
    }
}

// ==================== EMOJI PICKER ====================
function buildEmojiPicker() {
    const emojis = ['😀','😂','🥰','😎','🤩','😢','😡','👍','👎','❤️','🔥','⭐','🎉','💯','🙏','👋','🤗','😴','🤔','👀','🎵','📸','💬','✨','🌈','🍕','⚽️','🎮','📱','💡','🎯','🚀','💎','🌺','🐱','🐶','🦋','🌙','☀️','🍀'];
    const grid = document.querySelector('.emoji-grid');
    grid.innerHTML = '';
    emojis.forEach(e => {
        const span = document.createElement('span');
        span.textContent = e;
        span.onclick = () => {
            const input = $('conv-input');
            input.value += e;
            input.focus();
        };
        grid.appendChild(span);
    });
}

function toggleEmojiPicker() {
    const picker = $('emoji-picker');
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
}

// ==================== ÉVÉNEMENTS GLOBAUX ====================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('emoji-picker').style.display = 'none';
});

document.addEventListener('click', (e) => {
    const picker = $('emoji-picker');
    if (picker.style.display !== 'none' && !picker.contains(e.target) && !e.target.closest('.emoji-btn')) {
        picker.style.display = 'none';
    }
});

// Au retour sur l'onglet : on se remet à jour
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && me) resync();
});

document.addEventListener('DOMContentLoaded', init);
