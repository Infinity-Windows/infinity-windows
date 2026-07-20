# Transcript #2 — Window & Door Installer App: Map, Per-Unit IDs, QR/PIN, Toolbox Talks & Role Access

- **Project:** Infinity Windows / St. George Windows installation ops app
- **Date processed:** 2026-07-17
- **Speakers:** Speaker 1 = Taylor, Speaker 2 = Ammon
- **Source:** Slack-exported image transcript PDF (OCR'd)
- **Companion:** Transcript #1 — "St. George Windows app for QR-tracked installs, voice memos and role-based dashboards"

---

[00:00:00] Speaker 1: Urgent, um, as possible. So, um, take this entire transcript, audit it against everything we've created, and make it a thousand times better. Literally a thousand times better. And assume nothing. Ask me as many questions as you need. Never assume that I want one thing over another thing. Um, we may have retarded stupid ideas. Don't take all of our ideas as the gospel. Like, we are not smart people. We are just having ideas. And if there are better ideas correlating to things that we've talked about, express them to us. Because obviously there are window insulation companies out there that are dominating. We are just trying to— like, we don't even install windows. We're just trying to create a system with you to make this window insulation company way better. So, yeah. Anything else?

[00:01:16] Speaker 2: Well, I don't know that we talked about the map, but I was really excited about the map.

[00:01:19] Speaker 1: Oh, the map, yes. It would be a badass feature that— that it's an interface within the app, uh, for installer, for everyone to see. It's basically just a map, like a thre— a rendering, 2D or 3D rendering of a specific job that replicates the plan set, the PDF or the CAD, and shows the windows in the rendering, or the doors. Um.

[00:01:53] Speaker 2: So in these plan sets, then you get— you typically get two. One is the building plan set, and then another is the specs plan set. The building plan set will have numbers surrounding the building on first and second stories representing, uh, a particular window. So, for example, number 1 window might be a slider that's 6 feet wide and 4 feet tall. Um, and, uh, you will correlate the spec sheet, uh, of this slider. That information that I just said is not on the building plan set, it's on the specs plan set. Uh, but you will correlate the specs, number 1 window, and the specs on that one to number 1 on the plan set CAD. And so that's how you will locate things and assign data to these plan sets. We'll always download two plan sets, at least, for— for projects. Um, but let's say that there is a number 6 window that has— it's 6 feet tall and 4 feet wide. And it's a stationary window. It doesn't open or anything. But there's 30 of them on this building. You will have 30 windows potentially labeled number 6. So you will label around the building number 6, number 6, number 6, number 6, wherever they show up from the plan set. Uh, and then you will assign the same description for every single one of those windows because they are all perfectly identical. But there will be one spec sheet, one section in the spec sheet that gives you the description of this window. And it'll say, "Number 6 window," but that spec sheet will apply to 30 windows. That will happen with doors. That will happen— it will even be the case where sometimes they get past a certain number of number 6s, and then they change it to a number 14, and yet the specs are also completely identical. And it's just because they— they shipped them in a different way, or they're part of a different order and they came in later. But they're still an identical window, and you can recognize that and cross-reference it in the specs plan set. So you can say, "Number 14s, number 17s, and number 6s are all the exact same window."

[00:04:22] Speaker 1: A thought that I have about this is, um, if we're IDing these windows, right, um, so let's say we have 30 of these 6x4 windows on a job, right? All 30 of them have their own unique IDs, but they're all under a 6x4 window. Like, they all live under that category, right?

[00:04:50] Speaker 2: Yeah.

[00:04:54] Speaker 1: Um, is AI going to assign IDs, specific IDs, to our map, to our— to our pipeline on a project, or should we have someone? Like, we have these 30 windows, right? Is AI just going to randomly throw all 30 of the IDs where they need to go, or should we have the foreman go and place them? Say, "This is— this right here, the AI recognizes that this number 6 window is a 6x4, we'll place this ID here, and this ID here." Because they already exist within the app, all these windows, right? I think it might get confused on creating something else entirely when exporting shit from the plan set. Whether just creating an opening gap, saying, "This is the type of window it is from our catalog, assign it. This is the type of—" and it shows the map. You just have to assign the ID to it, or whatever.

[00:06:13] Speaker 2: The other thing that I'm thinking of just now is, if you assign a unique ID to all these number 6s if there's 30 of them, then it's going to ask you to go and grab the unique ID window to install it in this location on the map. Would it be better— I think it would be— to, when we're IDing a window, if there's multiple of these windows.

[00:06:36] Speaker 1: You ID it when you install it.

[00:06:38] Speaker 2: ID it when you install it, or you just ID this type of window, and then you have a quantity attached to that ID. So let's say I— let's say a unique ID gets created for this window whenever it changes projects instead of— or, like, based on the shipment. So we have unique ID, um, unique ID 30 of these windows come in from a drop, from a material drop. 15 are going to this location. So now I'm going to let the AI, or the app, know, "15 of— of these 30 are going here, and so we have a unique ID group." And so we log that unique ID group. And the only reason it's unique is because it's got to assign to another project. So when someone hauls it off in a truck, then they logged that it's going to this project, and he took 15 of them. And there's still 15 remaining.

[00:07:41] Speaker 1: The issue with that is that each window is not tracked down to the install. You can't track a specific window to its install.

[00:07:50] Speaker 2: That's true.

[00:07:51] Speaker 1: Well, um, well.

[00:07:52] Speaker 2: But then when you go to a wor— a container, like a Connex, you— are you going to go find your unique ID window?

[00:08:01] Speaker 1: No. The point of the unique ID isn't for location, uh, purposes. The unique ID per window is only to track it down to everything that happens to that specific window. That's the only— that's the only importance it has. You would track it just by the window type. For everything else.

[00:08:25] Speaker 2: So you're saying it all.

[00:08:26] Speaker 1: There's this amount of window type here. Each window has their own unique ID, but they all get categorized as this window.

[00:08:34] Speaker 2: I see.

[00:08:36] Speaker 1: You want everyone to have their own ID so that you can— so that you can track, like.

[00:08:42] Speaker 2: Assign a window to a guy, for their install.

[00:08:45] Speaker 1: Yeah.

[00:08:46] Speaker 2: Yeah.

[00:08:48] Speaker 1: I want to know if that's even necessary. Like, is there a function that we can create that would require— that would make so we don't have to take the time to ID every single window?

[00:09:00] Speaker 2: We.

[00:09:00] Speaker 1: Where a map would do this for us. A project map would do this for us. Where you just— you, like, a section on— on our map is the ID, right? If I want to see how this window was installed, I go on the map and I click, and I click that window or that door, and it pulls me up the info on it. Not, "I go find the exact window, I'm just guessing which one of these weird windows it is." Where I want to see, "No, I know exactly where this window is on the map. I see it on the map," right?

[00:09:37] Speaker 2: Yeah.

[00:09:39] Speaker 1: I'm standing there in front of it, and I click it on my app, and I see who installed it. All the shit that's— that was logged for this job.

[00:09:46] Speaker 2: Right. Yes. The— the map, the whole concept of the map should for sure be to funnel you into every single piece of information for that door.

[00:09:55] Speaker 1: It would need the ID because the ID saves all of the information for that specific window, from the time it gets delivered to the time it's there.

[00:10:02] Speaker 2: Well, I'm realizing.

[00:10:04] Speaker 1: But that's why— but that's the only reason it's important.

[00:10:06] Speaker 2: I'm realizing it can— it can still dual— the ID can kind of dual-will. Where, let's say, I have 30 doors that are exactly— or 30 windows that are exactly the same, and I have a unique ID for each one. The map doesn't have to care about the order that they get installed. But once you install that door, the ID's been set.

[00:10:25] Speaker 1: Yeah.

[00:10:25] Speaker 2: Or that window. The ID's been set. And then you can click on that, and it's been installed, and it'll say, "This was that window. This was the ID for that window. Here's what happened to the window. Here's all the data correlated to it."

[00:10:37] Speaker 1: Yeah. What you— yeah. What you do is you don't care about the ID. You just say, "I am assigned to this window slot for this window."

[00:10:46] Speaker 2: Yes.

[00:10:46] Speaker 1: You grab the window, you take it to where you're going, right?

[00:10:50] Speaker 2: Yep.

[00:10:51] Speaker 1: You scan it, or you— you click the— the section on the map, and you say, "Start install." It will say, "Scan QR code." That ID is now.

[00:11:01] Speaker 2: It takes it. Takes that spot.

[00:11:03] Speaker 1: Is now s— selected into that.

[00:11:06] Speaker 2: You would need to be able to.

[00:11:08] Speaker 1: Or— or you just, like, put in the PIN. Like, each— like, a 6— it could just be like a 6-digit PIN. Each window, their ID is like a 6-digit PIN. That's how we ID them.

[00:11:20] Speaker 2: Yeah.

[00:11:21] Speaker 1: Or a 2 letters and 2 numbers. Something unique that you— like, we don't have to plot your— take a QR code. You can just write it with marker. Write on it. Something easy.

[00:11:32] Speaker 2: Yeah.

[00:11:33] Speaker 1: Like, we don't need to waste time printing out a QR code. Sure, that's an easy way to make unique shit. I guess it would make sure everything's unique. You don't have to write a different code every time. QR code is nice that way. It's all.

[00:11:46] Speaker 2: QR code is kind of nice. And scanning it.

[00:11:52] Speaker 1: Or the.

[00:11:52] Speaker 2: If the QR code isn't too long.

[00:11:54] Speaker 1: The— the creating the QR code, you could also tell it to generate you a unique 6-digit code where you have the serial number ID that the QR code is, but also a 6-digit code.

[00:12:06] Speaker 2: That matches.

[00:12:06] Speaker 1: That you— you just write on it instead of printing a QR code on it. I don't know.

[00:12:11] Speaker 2: That could be part of the data sheet that gets printed.

[00:12:13] Speaker 1: Right.

[00:12:13] Speaker 2: Or— well, not necessarily. Because not with what we're saying. Data sheets for installation purposes, not for ID purposes.

[00:12:20] Speaker 1: Yes.

[00:12:22] Speaker 2: Um, yes.

[00:12:23] Speaker 1: So yeah, let's just talk about the installer's path.

[00:12:28] Speaker 2: The install.

[00:12:29] Speaker 1: They— they go to— they show up to the job. You got to go.

[00:12:33] Speaker 2: Okay.

[00:12:37] Speaker 1: We'll let you know what's going on. The installer shows up to the job. His first course of action is, let's say, he has all of his tools ready to go, blah, blah, blah, blah, blah. He opens his app, sees the windows he's expected to install. He starts it. Let's say he— it's the first window. He'll select a section, and then he'll say, "Okay, put in PIN, put in QR code." That specific window is now.

[00:13:18] Speaker 2: Now.

[00:13:18] Speaker 1: Assigned to that spot.

[00:13:19] Speaker 2: Claims that spot.

[00:13:20] Speaker 1: Now assigned to that spot. Then you go through the installation process.

[00:13:27] Speaker 2: You should be able to also reclaim a spot. So if a window got installed wrong, or in the wrong location for any reason, you should be able to have an undo option.

[00:13:38] Speaker 1: You can delete. Yeah, you can delete installation or undo installation, but it still saves the data of the installation.

[00:13:46] Speaker 2: So that we know there was an error.

[00:13:48] Speaker 1: Where we could have a spot in our app that only supervisors and foremen can see that's, um, uninstalled windows, failed installations, stuff like that.

[00:14:03] Speaker 2: Yeah.

[00:14:03] Speaker 1: If that pops up. Because that data is very valuable.

[00:14:09] Speaker 2: Happens all of the time.

[00:14:11] Speaker 1: Yeah. The big goal is to make sure that this happens.

[00:14:15] Speaker 2: A few times is much.

[00:14:15] Speaker 1: None of the time.

[00:14:17] Speaker 2: Catch issues way ahead of issues happening.

[00:14:26] Speaker 1: I— I can't think of anything else.

[00:14:31] Speaker 2: We want to add toolbox talks.

[00:14:33] Speaker 1: Oh, yeah. Safety toolbox talks. Toolbox talk. I'm sure you can understand the context of it. Um, use— don't AI-generate toolbox talks. Use actual, um, real certified toolbox talks for heavy equipment safety, um, heavy lifting safety, OSHA safety, any— any type of shit like that that would have to do with installing windows and doors. And the way it needs to function is, a toolbox talk is assigned immediately right after someone clocks in. So they clock in, and then they have to complete the toolbox talk. They have to acknowledge that they'll abide by it by clicking an acknowledge box, and then they have to sign their name and endorse it. And then the app will keep a.

[00:15:34] Speaker 2: Record.

[00:15:34] Speaker 1: A record and a full catalog of these completed toolbox talks. Not only that they— not only that each person did them, but it will also save a PDF of the actual toolbox talk with their signature and the date that they did it, if that makes sense. Um, that should be a pretty easy function to abide by. Um.

[00:15:59] Speaker 2: Want to also add that there needs to be a wide variety of logins. So one login would be what an installer sees and the particular set of data that we've kind of addressed. And then another login would be what a foreman sees. And then another login would be what a supervisor sees. And then another login would be what an owner sees. And those would be the different levels of access. An owner can see everything. A supervisor can see most things. A foreman can see a lot of things, and an installer can see some things, in essence. And we'll continue to put context around those different roles, but we definitely want you, the AI, to give recommendations for how to separate these roles and have them each be user-friendly to their particular role. Anything else? Okay. That is the conclusion.
