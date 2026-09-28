(function(global) {
  // Runtime configuration resolver
  global.SUPABASE_URL = "";
  global.SUPABASE_ANON_KEY = "";

  global.SECONDARY_SUPABASE_URL = "";
  global.SECONDARY_SUPABASE_ANON_KEY = "";

  global.AUTH_CONFIG = {
    SALT: "salt_default",
    TARGET_HASH: [],
    SESSION_HOURS: 24,
    REMEMBER_DAYS: 7
  };
})(typeof window !== 'undefined' ? window : this);
