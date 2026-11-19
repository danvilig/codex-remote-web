package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
)

type workspaceSkill struct {
	Name, Path, ShortDescription, Description string
	Enabled                                   bool
}

type workspacePlugin struct {
	ID, Name, InstallPolicy, Availability string
	Installed, Enabled                    bool
	Interface                             struct{ DisplayName, ShortDescription string }
}

func (p workspacePlugin) installable() bool {
	return p.InstallPolicy != "NOT_AVAILABLE" && (p.Availability == "" || p.Availability == "AVAILABLE")
}

type workspaceMarketplace struct {
	Name, Path string
	Plugins    []workspacePlugin
}

type workspacePluginSelection struct {
	plugin workspacePlugin
	market workspaceMarketplace
}

type workspaceCatalog struct {
	skills                            map[string]workspaceSkill
	plugins                           map[string]workspacePluginSelection
	skillIDs, pluginIDs               []string
	skillsAvailable, pluginsAvailable bool
}

func workspaceJSON(value any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(value)
	return strings.TrimSuffix(buf.String(), "\n")
}

func workspaceResourceID(parts ...string) string {
	return workspaceRevision([]byte(workspaceJSON(parts)))[:32]
}

func workspaceUUID() string {
	var data [16]byte
	_, _ = rand.Read(data[:])
	data[6] = data[6]&15 | 64
	data[8] = data[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", data[:4], data[4:6], data[6:8], data[8:10], data[10:])
}

func (s *workspace) catalog(ctx context.Context, cwd string, force bool) workspaceCatalog {
	var skills struct {
		Data []struct{ Skills []workspaceSkill }
	}
	var plugins struct{ Marketplaces []workspaceMarketplace }
	c := workspaceCatalog{skills: make(map[string]workspaceSkill), plugins: make(map[string]workspacePluginSelection)}
	var pending sync.WaitGroup
	pending.Go(func() {
		c.skillsAvailable = s.rpc(ctx, "skills/list", map[string]any{"cwds": []string{cwd}, "forceReload": force}, &skills) == nil
	})
	pending.Go(func() {
		c.pluginsAvailable = s.rpc(ctx, "plugin/list", map[string]any{"cwds": []string{cwd}, "forceRefetch": force}, &plugins) == nil
	})
	pending.Wait()
	for _, group := range skills.Data {
		for _, skill := range group.Skills {
			if len(c.skillIDs) >= 200 {
				break
			}
			if skill.Name != "" {
				id := workspaceResourceID("skill", workspaceDefault(skill.Path, skill.Name))
				if _, exists := c.skills[id]; !exists {
					c.skills[id] = skill
					c.skillIDs = append(c.skillIDs, id)
				}
			}
		}
	}
	for _, market := range plugins.Marketplaces {
		for _, plugin := range market.Plugins {
			if len(c.pluginIDs) >= 200 {
				break
			}
			if plugin.ID != "" {
				id := workspaceResourceID("plugin", workspaceDefault(market.Path, market.Name), plugin.ID)
				if _, exists := c.plugins[id]; !exists {
					c.plugins[id] = workspacePluginSelection{plugin, market}
					c.pluginIDs = append(c.pluginIDs, id)
				}
			}
		}
	}
	return c
}

func workspaceBoundedText(text string, limit int) string {
	runes := []rune(text)
	return string(runes[:min(len(runes), limit)])
}

func (s *workspace) publicCatalog(c workspaceCatalog, cwd string) map[string]any {
	skills, plugins := []map[string]any{}, []map[string]any{}
	for _, id := range c.skillIDs {
		skill := c.skills[id]
		removable := false
		if parent, _, _, err := s.managedSkill(skill.Path, cwd); err == nil {
			removable = true
			parent.Close()
		}
		skills = append(skills, map[string]any{"id": id, "name": workspaceBoundedText(skill.Name, 160),
			"description": workspaceBoundedText(workspaceDefault(skill.ShortDescription, skill.Description), 2000), "enabled": skill.Enabled, "removable": removable})
	}
	for _, id := range c.pluginIDs {
		selected := c.plugins[id]
		p := selected.plugin
		plugins = append(plugins, map[string]any{"id": id, "name": workspaceBoundedText(workspaceDefault(p.Interface.DisplayName, p.Name), 160),
			"description": workspaceBoundedText(p.Interface.ShortDescription, 2000), "installed": p.Installed, "enabled": p.Enabled,
			"installable": p.installable(), "marketplace": workspaceBoundedText(selected.market.Name, 160)})
	}
	return map[string]any{"skills": skills, "plugins": plugins, "skillsAvailable": c.skillsAvailable, "pluginsAvailable": c.pluginsAvailable}
}

func (s *workspace) composerTools(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "GET", "POST") {
		return
	}
	const unavailable = "This action is unavailable. Check the Codex connection and feature support."
	force := r.Method == "POST"
	if force && !workspaceMutationAllowed(r) {
		workspaceError(w, 403, "A same-origin workspace request is required.")
		return
	}
	cwd, _, err := s.browse(workspaceDefault(r.URL.Query().Get("cwd"), s.cwd))
	if err != nil {
		workspaceError(w, 400, unavailable)
		return
	}
	var ids []string
	if force {
		var payload map[string]json.RawMessage
		if decodeOne(http.MaxBytesReader(w, r.Body, 16384), &payload) != nil || len(payload) != 1 || json.Unmarshal(payload["ids"], &ids) != nil || ids == nil || len(ids) > 20 {
			workspaceError(w, 400, unavailable)
			return
		}
	}
	catalog := s.catalog(r.Context(), cwd, force)
	items := []map[string]string{}
	if force {
		seen := make(map[string]bool)
		for _, id := range ids {
			skill, exists := catalog.skills[id]
			if !exists || !skill.Enabled || skill.Path == "" || seen[id] {
				workspaceError(w, 400, unavailable)
				return
			}
			seen[id] = true
			items = append(items, map[string]string{"type": "skill", "name": skill.Name, "path": skill.Path})
		}
	} else {
		for _, id := range catalog.skillIDs {
			skill := catalog.skills[id]
			if skill.Enabled && skill.Path != "" {
				items = append(items, map[string]string{"id": id, "name": workspaceBoundedText(skill.Name, 160), "description": workspaceBoundedText(workspaceDefault(skill.ShortDescription, skill.Description), 2000)})
			}
		}
	}
	workspaceRespond(w, 200, map[string]any{"items": items})
}

type workspaceCustomizationRequest struct {
	Kind, ID, Action, Source string
	Confirmed                bool
}

func (s *workspace) customize(w http.ResponseWriter, r *http.Request) {
	if !workspaceMethod(w, r, "GET", "POST") {
		return
	}
	const unavailable = "Unable to apply this customization change. Reload the catalog and check permissions and resource ownership."
	write := r.Method == "POST"
	if write && !workspaceMutationAllowed(r) {
		workspaceError(w, 403, "A same-origin workspace request is required.")
		return
	}
	cwd, _, err := s.browse(workspaceDefault(r.URL.Query().Get("cwd"), s.cwd))
	if err != nil {
		workspaceError(w, 400, unavailable)
		return
	}
	if write {
		if !s.customizeMu.TryLock() {
			workspaceError(w, 409, unavailable)
			return
		}
		defer s.customizeMu.Unlock()
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
		d.DisallowUnknownFields()
		var input workspaceCustomizationRequest
		if d.Decode(&input) != nil || d.Decode(new(json.RawMessage)) != io.EOF || !input.Confirmed ||
			(input.Kind != "skill" && input.Kind != "plugin") || s.customizeWrite(r.Context(), cwd, input) != nil {
			workspaceError(w, 400, unavailable)
			return
		}
	}
	workspaceRespond(w, 200, s.publicCatalog(s.catalog(r.Context(), cwd, write), cwd))
}

func (s *workspace) customizeWrite(ctx context.Context, cwd string, input workspaceCustomizationRequest) error {
	if input.Action != "install" && input.Action != "uninstall" && input.Action != "enable" && input.Action != "disable" {
		return workspaceUnavailable
	}
	if input.Kind == "skill" && input.Action == "install" {
		if s.bridge == nil || s.bridge.current() == nil {
			return errDisconnected
		}
		path, err := s.installSkill(ctx, input.Source)
		if err != nil {
			return err
		}
		if err := s.rpc(ctx, "skills/config/write", map[string]any{"path": path, "enabled": true}, nil); err != nil {
			return err
		}
		return s.rpc(ctx, "skills/list", map[string]any{"cwds": []string{cwd}, "forceReload": true}, nil)
	}
	catalog := s.catalog(ctx, cwd, true)
	if input.Kind == "skill" {
		skill, ok := catalog.skills[input.ID]
		if !ok {
			return workspaceUnavailable
		}
		params := map[string]any{"enabled": input.Action == "enable"}
		if skill.Path != "" {
			params["path"] = skill.Path
		} else {
			params["name"] = skill.Name
		}
		if input.Action == "uninstall" {
			parent, name, info, err := s.managedSkill(skill.Path, cwd)
			if err != nil {
				return err
			}
			defer parent.Close()
			if err := s.rpc(ctx, "skills/config/write", params, nil); err != nil {
				return err
			}
			verified, _, actual, err := s.managedSkill(skill.Path, cwd)
			if err != nil {
				return err
			}
			defer verified.Close()
			before, beforeErr := parent.Stat(".")
			after, afterErr := verified.Stat(".")
			if beforeErr != nil || afterErr != nil || !os.SameFile(before, after) || !os.SameFile(info, actual) {
				return workspaceUnavailable
			}
			tombstone := ".crw-removed-" + rand.Text()
			if err := parent.Rename(name, tombstone); err != nil {
				return err
			}
			return parent.RemoveAll(tombstone)
		}
		return s.rpc(ctx, "skills/config/write", params, nil)
	}
	selected, ok := catalog.plugins[input.ID]
	if !ok {
		return workspaceUnavailable
	}
	p := selected.plugin
	if input.Action == "install" {
		if p.Installed || !p.installable() {
			return workspaceUnavailable
		}
		params := map[string]any{"pluginName": p.Name, "installAttemptId": workspaceUUID()}
		if selected.market.Path != "" {
			params["marketplacePath"] = selected.market.Path
		} else {
			params["remoteMarketplaceName"] = selected.market.Name
		}
		return s.rpc(ctx, "plugin/install", params, nil)
	}
	if !p.Installed {
		return workspaceUnavailable
	}
	if input.Action == "uninstall" {
		return s.rpc(ctx, "plugin/uninstall", map[string]string{"pluginId": p.ID}, nil)
	}
	settings, err := s.readSettings(ctx)
	if err != nil || settings.Version == nil || *settings.Version == "" {
		return workspaceUnavailable
	}
	return s.rpc(ctx, "config/batchWrite", map[string]any{"expectedVersion": *settings.Version, "reloadUserConfig": false, "edits": []map[string]any{
		{"keyPath": "plugins." + workspaceJSON(p.ID) + ".enabled", "value": input.Action == "enable", "mergeStrategy": "replace"},
	}}, nil)
}
