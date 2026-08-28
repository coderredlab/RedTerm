// @ts-nocheck
import { describe, expect, test } from "bun:test";

import {
  breadcrumbSegments,
  isRootPath,
  joinPath,
  parentPath,
} from "./explorer-path";

describe("explorer path helpers", () => {
  test("parentPath climbs POSIX paths to root", () => {
    expect(parentPath("/")).toBe("/");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/home/coderred")).toBe("/home");
    expect(parentPath("/home/coderred/")).toBe("/home");
  });

  test("parentPath roots Windows drives at the drive root", () => {
    expect(parentPath("C:/")).toBe("C:/");
    expect(parentPath("C:/Users")).toBe("C:/");
    expect(parentPath("C:/Users/coderred")).toBe("C:/Users");
    expect(parentPath("D:/projects/app/")).toBe("D:/projects");
  });

  test("isRootPath detects POSIX and drive roots", () => {
    expect(isRootPath("/")).toBe(true);
    expect(isRootPath("C:/")).toBe(true);
    expect(isRootPath("C:")).toBe(true);
    expect(isRootPath("/home")).toBe(false);
    expect(isRootPath("C:/Users")).toBe(false);
  });

  test("joinPath handles POSIX root and drive directories", () => {
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/home", "notes.txt")).toBe("/home/notes.txt");
    expect(joinPath("C:/", "Users")).toBe("C:/Users");
    expect(joinPath("C:/Users", "notes.txt")).toBe("C:/Users/notes.txt");
  });

  test("breadcrumbSegments split POSIX paths under a root segment", () => {
    expect(breadcrumbSegments("/")).toEqual([{ label: "/", path: "/" }]);
    expect(breadcrumbSegments("/home/coderred")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "coderred", path: "/home/coderred" },
    ]);
  });

  test("breadcrumbSegments root drive paths at the drive", () => {
    expect(breadcrumbSegments("C:/")).toEqual([{ label: "C:", path: "C:/" }]);
    expect(breadcrumbSegments("C:/Users/coderred")).toEqual([
      { label: "C:", path: "C:/" },
      { label: "Users", path: "C:/Users" },
      { label: "coderred", path: "C:/Users/coderred" },
    ]);
  });
});
