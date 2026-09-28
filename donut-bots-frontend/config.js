(function(global) {
  // Runtime configuration resolver
  global.SUPABASE_URL = "";
  global.SUPABASE_ANON_KEY = "";

  global.SECONDARY_SUPABASE_URL = "";
  global.SECONDARY_SUPABASE_ANON_KEY = "";

  global.AUTH_CONFIG = {
    SALT: "donut_smp_salt_9981247",
    TARGET_HASH: [
      "340aaf93106262940aa4668522a573a8c2323e0b62c94bd5ec4232a354b854cb", // admin : admin
      "f47863dd7c7c36276389357617ff007d581d1b34907209e9624ba5abf18fa2cd"  // admin : admin123
    ],
    SESSION_HOURS: 24,
    REMEMBER_DAYS: 7
  };
})(typeof window !== 'undefined' ? window : this);
