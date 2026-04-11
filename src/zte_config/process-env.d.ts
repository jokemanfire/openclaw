declare const process: {
  env: {
    NODE_ENV?: string;
    DEBUG_SQLITE_VEC?: string;
    [key: string]: string | undefined;
  };
  cwd: () => string;
};

