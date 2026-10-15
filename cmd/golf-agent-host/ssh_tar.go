package main

// Moving a working copy to an SSH host and back as tar streams over the SSH session (the host needs only a POSIX shell and tar).
// The archive sent is built here from the container's own clone; the archive received is untrusted output of the tool, so it is
// extracted with every path checked: relative, no "..", nothing written through a symlink, regular files, directories and
// symlinks only, bounded in entries and bytes.

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxArchiveBytes   = 1 << 30 // what a tool's working copy may grow to
	maxArchiveEntries = 200000
)

// writeArchive streams dir (under prefix/) and extra files into w.
func writeArchive(w io.Writer, dir, prefix string, extra map[string][]byte) error {
	tw := tar.NewWriter(w)
	now := time.Now()
	for name, data := range extra {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(data)), ModTime: now, Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		if _, err := tw.Write(data); err != nil {
			return err
		}
	}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		name := path.Join(prefix, filepath.ToSlash(rel))
		info, err := d.Info()
		if err != nil {
			return err
		}
		link := ""
		if info.Mode()&fs.ModeSymlink != 0 {
			if link, err = os.Readlink(p); err != nil {
				return err
			}
		} else if !info.Mode().IsRegular() && !info.IsDir() {
			return nil
		}
		header, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		header.Name, header.Uname, header.Gname, header.Uid, header.Gid = name, "", "", 0, 0
		if info.IsDir() {
			header.Name += "/"
		}
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			_, err = io.Copy(tw, f)
			f.Close()
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	return tw.Close()
}

// cleanMember turns an archive name into a safe relative path, or "" for the root and for .git (never taken from the host).
func cleanMember(name string) (string, error) {
	name = strings.TrimPrefix(name, "./")
	if name == "" || name == "." {
		return "", nil
	}
	if strings.HasPrefix(name, "/") || strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("archive member %q is absolute", clip(name, 100))
	}
	clean := path.Clean(name)
	for _, part := range strings.Split(clean, "/") {
		if part == ".." {
			return "", fmt.Errorf("archive member %q leaves the working copy", clip(name, 100))
		}
	}
	if clean == ".git" || strings.HasPrefix(clean, ".git/") {
		return "", nil
	}
	return clean, nil
}

// noSymlinkParents refuses a target whose parent directories (below root) include a symlink.
func noSymlinkParents(root, rel string) error {
	dir := root
	parts := strings.Split(rel, "/")
	for _, part := range parts[:len(parts)-1] {
		dir = filepath.Join(dir, part)
		info, err := os.Lstat(dir)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("archive member %q is under a symlink or file", clip(rel, 100))
		}
	}
	return nil
}

// extractArchive reads an untrusted tar stream into root (an empty private directory).
func extractArchive(r io.Reader, root string) error {
	tr := tar.NewReader(r)
	var total int64
	for entries := 0; ; entries++ {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("reading the working copy archive: %v", err)
		}
		if entries >= maxArchiveEntries {
			return errors.New("the working copy has too many files")
		}
		rel, err := cleanMember(header.Name)
		if err != nil {
			return err
		}
		if rel == "" {
			continue
		}
		if err := noSymlinkParents(root, rel); err != nil {
			return err
		}
		target := filepath.Join(root, filepath.FromSlash(rel))
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
		case tar.TypeReg:
			total += header.Size
			if header.Size < 0 || total > maxArchiveBytes {
				return errors.New("the working copy is larger than 1 GiB")
			}
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			mode := os.FileMode(0644)
			if header.Mode&0111 != 0 {
				mode = 0755
			}
			_ = os.Remove(target)
			f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return err
			}
			_, err = io.CopyN(f, tr, header.Size)
			if closeErr := f.Close(); err == nil {
				err = closeErr
			}
			if err != nil {
				return err
			}
		case tar.TypeSymlink:
			if len(header.Linkname) > 4096 || strings.ContainsRune(header.Linkname, 0) {
				return errors.New("archive symlink malformed")
			}
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			_ = os.Remove(target)
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
		default:
			// Hard links, devices and FIFOs are not part of a proposal.
		}
	}
}

// replaceWorkTree makes repo's working tree (everything but .git) exactly the tree in from.
func replaceWorkTree(repo, from string) error {
	entries, err := os.ReadDir(repo)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() != ".git" {
			if err := os.RemoveAll(filepath.Join(repo, e.Name())); err != nil {
				return err
			}
		}
	}
	entries, err = os.ReadDir(from)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() == ".git" {
			continue
		}
		if err := os.Rename(filepath.Join(from, e.Name()), filepath.Join(repo, e.Name())); err != nil {
			return err
		}
	}
	return nil
}
