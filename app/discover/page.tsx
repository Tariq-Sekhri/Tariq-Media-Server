"use client";

import { useEffect } from "react";

export default function DiscoverRedirect() {
  useEffect(() => {
    window.location.replace("/?section=discover");
  }, []);
  return null;
}
