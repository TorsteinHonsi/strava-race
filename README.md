# Strava Race

A Chrome extension that races two of more Strava activities against each other. They can be either your own or your friends' activities. Open an activity, pick one or more others to compare it with, and press Play. Markers race along a shared map and an elevation profile, so you can see who was ahead, where, and by how much.

## Features

- **A Race menu item on every Strava activity page.** It opens the race view for that activity.
- **Add racers** in any of these ways:
  - paste an activity URL or ID
  - pick from the activity's **matched activities** (other runs on the same route), or add all of them at once
  - pick from your **recent activities**
- **Shared map** (Highcharts Maps), with topographic, OpenStreetMap and satellite tiles. Activities that are nowhere near the primary route are left off the map, and a note says so.
- **Elevation profiles** laid on top of each other, with distance along the x-axis. Click the profile to jump to the moment that racer reached that point.
- **Play** the race at 1×–600× speed, or **drag the timeline** to scrub back and forth.
- **Elapsed or moving time**, and an optional **Follow leader** that pans the map along with the race.
- **Live standings** with the gap to the leader.
- **Labels by date or athlete**, so activities with the same name stay easy to tell apart.
- **Light and dark mode** that follow your system setting.

## Install

The extension isn't in the Chrome Web Store, so you load it unpacked:

1. Clone this repository:

   ```bash
   git clone https://github.com/TorsteinHonsi/strava-race.git
   ```

2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `strava-race` folder.
4. Open any activity on [strava.com](https://www.strava.com) while logged in, and click **Race** in the left-hand menu.

## How it works

There are no API keys and no OAuth app: the extension uses the Strava session you're already logged in with.
